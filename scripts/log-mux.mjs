// The only process that writes the review's stdout: it prints the tool log and, between whole records, whatever the
// activity worker rendered in the meantime. Two writers interleaved a fold marker with tool output, which the runner
// then paired with the wrong group.
import { fstatSync, openSync, readFileSync, readSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

const rendered = join(process.env.RUNNER_TEMP, "injected.rendered");
const cursor = join(process.env.RUNNER_TEMP, "injected.offset");
// The worker can outlive the tool stream, so the offset is handed to a final drain.
let offset = 0;
try {
  offset = Number(readFileSync(cursor, "utf8").trim() || 0);
} catch {}
const activityBuffer = Buffer.allocUnsafe(64 * 1024);
let renderedFd;
const drain = () => {
  try {
    renderedFd ??= openSync(rendered, "r");
  } catch {
    return; // The optional activity log may be unavailable.
  }
  const end = fstatSync(renderedFd).size;
  if (end <= offset) return;
  while (offset < end) {
    const size = readSync(renderedFd, activityBuffer, 0, Math.min(end - offset, activityBuffer.length), offset);
    if (!size) break;
    for (let written = 0; written < size;) written += writeSync(1, activityBuffer, written, size - written);
    offset += size;
  }
  writeFileSync(cursor, String(offset));
};

if (process.argv.includes("--drain")) {
  drain();
  process.exit(0);
}

let pending = "", inGroup = false;
const decoder = new TextDecoder();
// A record is one line, or a whole fold from its header to its end marker; the worker's output waits for the boundary.
for await (const chunk of Bun.stdin.stream()) {
  pending += decoder.decode(chunk, { stream: true });
  for (let end; (end = pending.indexOf("\n")) !== -1;) {
    const line = pending.slice(0, end + 1);
    pending = pending.slice(end + 1);
    if (!inGroup) drain();
    writeSync(1, line);
    if (line.startsWith("::group::")) inGroup = true;
    else if (line.startsWith("::endgroup::")) inGroup = false;
  }
}
if (pending) {
  if (!inGroup) drain();
  writeSync(1, pending);
}
if (!inGroup) drain();
