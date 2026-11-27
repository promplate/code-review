// jq encodes each complete formatted record as one JSON string. Only this process writes the two streams to stdout.
import { closeSync, fstatSync, openSync, readFileSync, readSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

const rendered = join(process.env.RUNNER_TEMP, "injected.rendered");
const cursor = join(process.env.RUNNER_TEMP, "injected.offset");
// Each retry starts another mux; only fully printed activity may be skipped by it or by the final drain.
let offset = 0;
try { offset = Number(readFileSync(cursor, "utf8")); }
catch (error) { if (error.code !== "ENOENT") throw error; }
if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid activity log cursor");

function writeRecord(frame) {
  const record = JSON.parse(frame.toString("utf8"));
  if (typeof record !== "string") throw new Error("Expected a formatted log string");
  // Preserve jq -r's trailing newline. A pipe may accept only part of a large UTF-8 record at a time.
  const bytes = Buffer.from(record + "\n");
  for (let written = 0; written < bytes.length;) written += writeSync(1, bytes, written, bytes.length - written);
}

function frames(emit) {
  let parts = [];
  return {
    push(chunk) {
      let start = 0;
      for (let end; (end = chunk.indexOf(10, start)) !== -1; start = end + 1) {
        const tail = chunk.subarray(start, end);
        const frame = parts.length ? Buffer.concat([...parts, tail]) : tail;
        parts = [];
        emit(frame);
      }
      // Own the unfinished bytes: the file reader reuses its fixed-size buffer on the next read.
      if (start < chunk.length) parts.push(Buffer.from(chunk.subarray(start)));
    },
    get pending() { return parts.length > 0; },
  };
}

const activity = frames(frame => {
  writeRecord(frame);
  offset += frame.length + 1;
  writeFileSync(cursor, String(offset));
});
const buffer = Buffer.allocUnsafe(64 * 1024);
let renderedFd, readOffset = offset;
function drain() {
  try { renderedFd ??= openSync(rendered, "r"); }
  catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  // Snapshot the available bytes so a busy worker cannot keep this drain open indefinitely.
  const end = fstatSync(renderedFd).size;
  while (readOffset < end) {
    const size = readSync(renderedFd, buffer, 0, Math.min(end - readOffset, buffer.length), readOffset);
    if (!size) break;
    readOffset += size;
    activity.push(buffer.subarray(0, size));
  }
}

let timer;
try {
  drain();
  if (process.argv.includes("--drain")) {
    // run-review.sh waits for the worker first, so a remaining fragment is a failed record, not an in-flight write.
    if (activity.pending) throw new Error("Incomplete activity log record");
  } else {
    // Codex may reason or wait on a command without emitting any tool records for minutes.
    timer = setInterval(() => {
      try { drain(); }
      // Bun reports timer exceptions without stopping the loop; never consume more bytes after a failed frame.
      catch (error) { console.error(error); process.exit(1); }
    }, 50);
    const tools = frames(frame => { drain(); writeRecord(frame); });
    for await (const chunk of Bun.stdin.stream()) tools.push(Buffer.from(chunk));
    if (tools.pending) throw new Error("Incomplete tool log record");
    drain();
  }
} finally {
  clearInterval(timer);
  if (renderedFd !== undefined) closeSync(renderedFd);
}
