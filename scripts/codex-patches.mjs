import { createInterface } from "node:readline";
import { join } from "node:path";

const MAX_READ = 16 * 1024 * 1024;
const parse = text => { try { return JSON.parse(text); } catch { return undefined; } };

function rolloutFor(thread) {
  if (!process.env.CODEX_HOME || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(thread)) return;
  try {
    const files = [...new Bun.Glob(`????/??/??/rollout-*-${thread}.jsonl`).scanSync({ cwd: join(process.env.CODEX_HOME, "sessions"), absolute: true })];
    if (files.length === 1) return files[0];
  } catch { /* An unavailable transcript leaves the exec log usable. */ }
}

function filePatch(change) {
  const text = change.type === "update" ? change.unified_diff : change.content;
  if (typeof text !== "string") return;
  let lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  if (change.type === "update" && lines.length) {
    // The file row supplies the headers. Inside a hunk, even `+++` or `---` can be file content.
    const start = lines.findIndex(line => line.startsWith("@@ "));
    if (start < 0) return;
    lines = lines.slice(start);
  } else if (change.type === "add" || change.type === "delete") {
    const prefix = change.type === "add" ? "+" : "-";
    lines = lines.map(line => prefix + line);
  }
  return { lines, added: lines.filter(line => line.startsWith("+")).length, removed: lines.filter(line => line.startsWith("-")).length };
}

function attach(item, changes) {
  if (!changes || item.changes.length !== Object.keys(changes).length) return false;
  const patches = item.changes.map(({ path, kind }) => Object.hasOwn(changes, path) && changes[path]?.type === kind ? filePatch(changes[path]) : undefined);
  if (patches.some(patch => !patch)) return false;
  item.changes.forEach((change, i) => { change.patch = patches[i]; });
  return true;
}

if (process.argv[2] === "--baseline") {
  // Capture the cursor before starting a resume, including when its first edit repeats a historical path.
  const thread = process.argv[3];
  const file = rolloutFor(thread);
  let offset = null;
  try { if (file) offset = (await Bun.file(file).stat()).size; } catch { /* Leave the resume unpaired. */ }
  console.log(JSON.stringify({ thread, offset }));
} else {
  const baseline = parse(process.argv[2]);
  let thread, file, offset = baseline?.offset ?? 0, paired = true, inherited = false;
  const pending = [], completed = new Set();

  async function nextPatch() {
    const deadline = performance.now() + 400;
    do {
      if (pending.length) return pending.shift();
      file ??= rolloutFor(thread);
      if (file) {
        const transcript = Bun.file(file);
        const { size } = await transcript.stat();
        if (size < offset || size - offset > MAX_READ) return;
        if (size > offset) {
          const bytes = Buffer.from(await transcript.slice(offset, size).arrayBuffer());
          const end = bytes.lastIndexOf(10) + 1;
          offset += end;
          for (const line of bytes.subarray(0, end).toString("utf8").split("\n")) {
            if (!line.includes('"FileChange"') && !line.includes('"session_meta"') && !line.includes('"thread_settings_applied"')) continue;
            const { type, payload } = parse(line) ?? {};
            // A fork can copy the parent's events into its new file before appending its own settings.
            if (type === "session_meta" && payload?.id === thread) inherited = !!payload.forked_from_id;
            if (type !== "event_msg" || (payload?.thread_id && payload.thread_id !== thread)) continue;
            if (payload?.type === "thread_settings_applied" && payload.thread_id === thread) inherited = false;
            if (!inherited && payload?.type === "item_completed" && payload.item?.type === "FileChange" && payload.item.status === "completed") pending.push(payload.item.changes);
          }
          if (pending.length) return pending.shift();
        }
      }
      await Bun.sleep(20);
    } while (performance.now() < deadline);
  }

  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    const event = parse(line);
    if (event?.type === "thread.started") {
      thread = event.thread_id;
      paired = !!thread && (!baseline || (baseline.thread === thread && Number.isSafeInteger(baseline.offset)));
    }
    const item = event?.item;
    if (paired && thread && event?.type === "item.completed" && item?.type === "file_change" && item.status === "completed" && !completed.has(item.id)) {
      if (item.id) completed.add(item.id);
      // Exec rewrites item IDs. The two streams preserve completion order; stop pairing at the first gap or mismatch.
      try {
        paired = attach(item, await nextPatch());
        if (paired) { console.log(JSON.stringify(event)); continue; }
      } catch { paired = false; }
    }
    console.log(line);
  }
}
