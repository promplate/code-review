// The only process that writes the review's stdout: it prints the tool log and, between whole records, whatever the
// activity worker rendered in the meantime. Two writers interleaved a fold marker with tool output, which the runner
// then paired with the wrong group.
import { readFileSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

const rendered = join(process.env.RUNNER_TEMP, "injected.rendered");
const cursor = join(process.env.RUNNER_TEMP, "injected.offset");
// The worker can outlive the tool stream, so the offset is handed to a final drain.
let offset = 0;
try {
  offset = Number(readFileSync(cursor, "utf8").trim() || 0);
} catch {}
const drain = () => {
  let content;
  try {
    content = readFileSync(rendered);
  } catch {
    return; // The worker creates it; nothing to drain before that.
  }
  if (content.length <= offset) return;
  writeSync(1, content.subarray(offset));
  offset = content.length;
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
