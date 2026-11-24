import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneSnapshotReasoning } from "./snapshot-reasoning";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));
const a = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", b = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", c = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const row = (type: string, payload: any, ending = "\n") => JSON.stringify({ timestamp: "2026-11-24T00:00:00Z", type, payload }) + ending;
const meta = (id: string, base?: any) => row("session_meta", { id, history_mode: "paginated", ...(base ? { history_base: base } : {}) });
const reasoning = (label: string) => ({ type: "reasoning", id: `rs_${label}`, summary: [{ type: "summary_text", text: `summary ${label}` }], content: [{ type: "reasoning_text", text: `body ${label}` }], encrypted_content: `opaque_${label}` });
const message = { type: "message", role: "user", content: [{ type: "input_text", text: "Continue." }] };
const compact = (label: string, extra = {}) => row("compacted", { message: "", replacement_history: [message], window_number: 1, guardian_history: [reasoning(label)], ...extra });
function fixture(id: string, rows: string[]) {
  const directory = mkdtempSync(join(tmpdir(), "snapshot-reasoning-")); directories.push(directory);
  const file = write(directory, id, rows);
  return { directory, file, before: readFileSync(file), rows };
}
function write(directory: string, id: string, rows: string[]) {
  const file = join(directory, `rollout-2026-11-24T00-00-00-${id}.jsonl`);
  writeFileSync(file, rows.join("")); return file;
}
const records = (file: string) => readFileSync(file, "utf8").trimEnd().split("\n").map(value => JSON.parse(value));
const sizes = (bytes: Buffer) => bytes.toString("utf8").split(/(?<=\n)/).filter(Boolean).map(line => Buffer.byteLength(line));

test("clears only obsolete reasoning bodies, preserving current checkpoints and every byte position", async () => {
  const completed = (label: string) => row("event_msg", { type: "item_completed", turn_id: "turn", item: { type: "Reasoning", id: label, summary_text: [`summary ${label}`], raw_content: [`raw ${label}`] } });
  const old = row("response_item", { ...reasoning("旧正文🙂"), guardian_metadata: { ordinal: "keep-number" } }, "\r\n")
    .replace('"keep-number"', "9007199254740993");
  const rows = [meta(a), row("response_item", message), old, completed("old-event"), compact("old-guardian"),
    compact("live-guardian"), row("response_item", reasoning("live")), completed("live-event")];
  const f = fixture(a, rows), keepFrom = Buffer.byteLength(rows.slice(0, 5).join(""));
  utimesSync(f.file, 1_700_000_000, 1_700_000_001);
  const times = statSync(f.file);
  const result = await pruneSnapshotReasoning(f.directory), after = readFileSync(f.file), parsed = records(f.file);
  expect(result).toMatchObject({ files: 1, records: 3 });
  expect(result.bytesRemoved).toBeGreaterThan(100);
  expect(sizes(after)).toEqual(sizes(f.before));
  expect(after.subarray(keepFrom)).toEqual(f.before.subarray(keepFrom));
  expect(after.toString()).toContain('"ordinal":9007199254740993');
  expect(after.toString()).not.toContain("summary 旧正文🙂");
  expect(after.toString()).toContain("rs_旧正文🙂");
  expect(parsed[2].payload).toMatchObject({ summary: [], content: null, encrypted_content: null });
  expect(parsed[3].payload.item).toMatchObject({ id: "old-event", summary_text: [], raw_content: [] });
  expect(parsed[4].payload.guardian_history[0]).toMatchObject({ id: "rs_old-guardian", summary: [], content: null, encrypted_content: null });
  expect(parsed[1]).toEqual(JSON.parse(rows[1]));
  expect(statSync(f.file).mtimeMs).toBe(times.mtimeMs);
  expect(await pruneSnapshotReasoning(f.directory)).toEqual({ files: 0, records: 0, bytesRemoved: 0 });
  expect(readFileSync(f.file)).toEqual(after);
});

test("an early fork preserves its parent's earlier checkpoint and suffix, across inherited parents", async () => {
  const parentRows = [meta(a), row("response_item", reasoning("discard")), compact("first"), row("response_item", reasoning("fork-needs")),
    compact("latest"), row("response_item", reasoning("parent-live"))];
  const f = fixture(a, parentRows), cutoff = Buffer.byteLength(parentRows.slice(0, 4).join(""));
  const childRows = [meta(b, { thread_id: a, end_byte_offset: cutoff, end_ordinal_exclusive: 4 }), row("response_item", reasoning("child-live"))];
  const child = write(f.directory, b, childRows);
  const grandchild = write(f.directory, c, [meta(c, { thread_id: b, end_byte_offset: Buffer.byteLength(childRows.join("")), end_ordinal_exclusive: 6 }), compact("grandchild")]);
  const childBefore = readFileSync(child), grandchildBefore = readFileSync(grandchild);
  expect(await pruneSnapshotReasoning(f.directory)).toMatchObject({ files: 1, records: 1 });
  expect(records(f.file)[1].payload.encrypted_content).toBeNull();
  expect(records(f.file)[3].payload.encrypted_content).toBe("opaque_fork-needs");
  expect(readFileSync(child)).toEqual(childBefore);
  expect(readFileSync(grandchild)).toEqual(grandchildBefore);
  expect(readFileSync(f.file).subarray(Buffer.byteLength(parentRows.slice(0, 2).join("")))).toEqual(f.before.subarray(Buffer.byteLength(parentRows.slice(0, 2).join(""))));
});

test.each(["x", "xy"])("clears a short obsolete reasoning body %s without moving its checkpoint", async body => {
  const old = row("response_item", { type: "reasoning", summary: [], encrypted_content: body });
  const f = fixture(a, [meta(a), old, compact("current")]);
  expect(await pruneSnapshotReasoning(f.directory)).toMatchObject({ records: 1 });
  expect(records(f.file)[1].payload.encrypted_content).toBe("");
  expect(sizes(readFileSync(f.file))).toEqual(sizes(f.before));
});

test.each(["none", "incomplete", "legacy", "malformed", "partial", "rollback"])("preserves %s history instead of guessing a boundary", async kind => {
  const rows = [meta(a), row("response_item", reasoning("old"))];
  if (kind !== "none") rows.push(compact("earlier"));
  if (kind === "incomplete") rows.push(row("response_item", reasoning("newer")), row("compacted", { message: "legacy summary" }));
  if (kind === "legacy") rows[0] = row("session_meta", { id: a });
  if (kind === "malformed") rows.push("{broken JSON}\n");
  if (kind === "partial") rows.push('{"type":"response_item"');
  if (kind === "rollback") rows.push(row("event_msg", { type: "thread_rolled_back", num_turns: 1 }));
  const f = fixture(a, rows);
  expect(await pruneSnapshotReasoning(f.directory)).toMatchObject({ files: 0, records: 0, bytesRemoved: 0 });
  expect(readFileSync(f.file)).toEqual(f.before);
});

test("an incomplete child checkpoint requires full replay of its ancestors", async () => {
  const rows = [meta(a), row("response_item", reasoning("ancestor-needed")), compact("parent")];
  const f = fixture(a, rows);
  const child = write(f.directory, b, [meta(b, { thread_id: a, end_byte_offset: f.before.length, end_ordinal_exclusive: rows.length }),
    row("compacted", { message: "Legacy checkpoint" })]);
  const beforeChild = readFileSync(child);
  expect((await pruneSnapshotReasoning(f.directory)).skippedReason).toBeString();
  expect(readFileSync(f.file)).toEqual(f.before);
  expect(readFileSync(child)).toEqual(beforeChild);
});

test.each(["timestamp", "message", "ordinal", "metadata-count", "metadata-item", "replacement-item", "message-role", "message-text", "guardian-item", "reasoning-summary", "tool-call", "tool-output", "unknown-item", "history-sequence", "next-item-ordinal", "token-usage", "retained-context", "guardian-sources", "dynamic-tools", "verified-answers", "usage-counters", "window-allocation", "nested-namespace", "defer-loading"])("does not prune behind a JSON-valid checkpoint with invalid %s", async kind => {
  const checkpoint = JSON.parse(compact("latest"));
  if (kind === "timestamp") delete checkpoint.timestamp;
  if (kind === "message") checkpoint.payload.message = 42;
  if (kind === "ordinal") checkpoint.ordinal = -1;
  if (kind === "metadata-count") checkpoint.payload.replacement_history_metadata = [];
  if (kind === "metadata-item") checkpoint.payload.replacement_history_metadata = [null];
  if (kind === "replacement-item") checkpoint.payload.replacement_history = [null];
  if (kind === "message-role") delete checkpoint.payload.replacement_history[0].role;
  if (kind === "message-text") checkpoint.payload.replacement_history[0].content[0].text = 42;
  if (kind === "guardian-item") checkpoint.payload.guardian_history = ["invalid"];
  if (kind === "reasoning-summary") checkpoint.payload.guardian_history[0].summary = null;
  if (kind === "tool-call") checkpoint.payload.guardian_history = [{ type: "function_call", name: "exec", call_id: "call" }];
  if (kind === "tool-output") checkpoint.payload.guardian_history = [{ type: "custom_tool_call_output", call_id: "call", output: {} }];
  if (kind === "unknown-item") checkpoint.payload.replacement_history = [{ type: "future_state" }];
  if (kind === "history-sequence") checkpoint.payload.replacement_history_metadata = [{ history_sequence: "5" }];
  if (kind === "next-item-ordinal") checkpoint.payload.resume_metadata = { next_item_ordinal: "broken" };
  if (kind === "token-usage") checkpoint.payload.latest_token_usage_record = {};
  if (kind === "retained-context") checkpoint.payload.retained_context = { verified_answers: [] };
  if (kind === "guardian-sources") checkpoint.payload.replacement_history_metadata = [{ guardian_sources: [null] }];
  if (kind === "dynamic-tools") checkpoint.payload.resume_metadata = { dynamic_tools: {} };
  if (kind === "verified-answers") checkpoint.payload.retained_context = { verified_answers: [{}], incomplete: false };
  if (kind === "window-allocation") checkpoint.payload.window_id = {};
  if (kind === "nested-namespace" || kind === "defer-loading") {
    const tool = kind === "nested-namespace"
      ? { type: "namespace", name: "inner", description: "", tools: [] }
      : { type: "function", name: "lookup", description: "", inputSchema: {}, deferLoading: "false" };
    checkpoint.payload.resume_metadata = { dynamic_tools: { thread_id: a, tools: [{ type: "namespace", name: "ns", description: "", tools: [tool] }] } };
  }
  if (kind === "usage-counters") checkpoint.payload.latest_token_usage_record = {
    thread_id: a, turn_id: "turn", session_id: a, root_turn_id: "root", response_id: "response", usage: {}, turn_token_usage: {}, thread_token_usage: {},
  };
  const f = fixture(a, [meta(a), row("response_item", reasoning("still-needed")), JSON.stringify(checkpoint) + "\n"]);
  expect((await pruneSnapshotReasoning(f.directory)).skippedReason).toBeString();
  expect(readFileSync(f.file)).toEqual(f.before);
});

test.each(["1.0", "1e0"])("preserves reasoning when an integer field is written as %s", async token => {
  // JSON.stringify normalizes both tokens to 1.
  const checkpoint = compact("current").replace('"window_number":1', '"window_number":' + token);
  const f = fixture(a, [meta(a), row("response_item", reasoning("needed")), checkpoint]);
  expect((await pruneSnapshotReasoning(f.directory)).skippedReason).toBeString();
  expect(readFileSync(f.file)).toEqual(f.before);
});

test("prunes behind a checkpoint whose metadata carries its wire types", async () => {
  const checkpoint = JSON.parse(compact("latest"));
  checkpoint.payload.replacement_history_metadata = [{ history_sequence: 9, sampled_through_sequence: 7, fallback_token_limit_override: 100 }];
  checkpoint.payload.resume_metadata = { next_item_ordinal: 24, rejected_audio_file_ids: ["file"], previous_turn_settings: { model: "gpt-6", realtime_active: false } };
  const usage = { input_tokens: 2, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: 3 };
  checkpoint.payload.latest_token_usage_record = { thread_id: a, turn_id: "turn", session_id: a, root_turn_id: "root", response_id: "response", usage, turn_token_usage: usage, thread_token_usage: usage };
  checkpoint.payload.retained_context = { verified_answers: [], incomplete: false, next_order: 2 };
  checkpoint.payload.window_id = { salt: "window", ordinal: 1, value: 37 };
  checkpoint.payload.resume_metadata.dynamic_tools = { thread_id: a, tools: [
    { type: "namespace", name: "ns", description: "", tools: [{ type: "function", name: "lookup", description: "", inputSchema: {}, deferLoading: true }] },
  ] };
  const f = fixture(a, [meta(a), row("response_item", reasoning("old")), JSON.stringify(checkpoint) + "\n"]);
  expect(await pruneSnapshotReasoning(f.directory)).toMatchObject({ files: 1, records: 1 });
  expect(readFileSync(f.file)).not.toContain("summary old");
});

test("preserves multimodal checkpoint content while pruning its obsolete prefix", async () => {
  const history = [{ ...message, content: [
    { type: "input_text", text: "Keep these attachments." }, { type: "input_image", file_id: "file-image", detail: "high" },
    { type: "input_audio", audio_url: "data:audio/wav;base64,AAAA" },
  ] }, { type: "compaction", encrypted_content: "opaque-checkpoint" }];
  const checkpoint = compact("guardian", { replacement_history: history, replacement_history_metadata: [{}, {}] });
  const f = fixture(a, [meta(a), row("response_item", reasoning("old")), checkpoint]);
  expect(await pruneSnapshotReasoning(f.directory)).toMatchObject({ files: 1, records: 1 });
  expect(readFileSync(f.file).subarray(-Buffer.byteLength(checkpoint))).toEqual(Buffer.from(checkpoint));
});

test("preserves checkpoint tool calls and structured results", async () => {
  const guardian = [
    { type: "custom_tool_call", id: "tool", name: "exec", call_id: "call", input: "run()" },
    { type: "custom_tool_call_output", call_id: "call", output: [{ type: "input_text", text: "result" }] },
    { type: "function_call", name: "lookup", call_id: "lookup", arguments: "{}" },
    { type: "function_call_output", call_id: "lookup", output: "found" },
  ];
  const checkpoint = compact("guardian", { guardian_history: guardian });
  const f = fixture(a, [meta(a), row("response_item", reasoning("old")), checkpoint]);
  expect(await pruneSnapshotReasoning(f.directory)).toMatchObject({ files: 1, records: 1 });
  expect(readFileSync(f.file).subarray(-Buffer.byteLength(checkpoint))).toEqual(Buffer.from(checkpoint));
});

test.each(["missing", "mid-record", "ordinal", "cycle", "duplicate", "symlink", "compressed"])("leaves all files unchanged for a %s lineage", async kind => {
  const rows = [meta(a), row("response_item", reasoning("old")), compact("latest")];
  const f = fixture(a, rows), end = f.before.length;
  const base = { thread_id: kind === "missing" ? c : a, end_byte_offset: kind === "mid-record" ? end - 1 : end, end_ordinal_exclusive: kind === "ordinal" ? 2 : 3 };
  if (kind === "cycle") {
    // Self-reference is invalid even when its recorded endpoint exists.
    write(f.directory, b, [meta(b, { thread_id: b, end_byte_offset: 0, end_ordinal_exclusive: 0 })]);
  } else if (kind === "duplicate") {
    mkdirSync(join(f.directory, "nested")); write(join(f.directory, "nested"), a, rows);
  } else if (kind === "symlink") symlinkSync(f.file, join(f.directory, `rollout-linked-${b}.jsonl`));
  else if (kind === "compressed") writeFileSync(join(f.directory, `rollout-future-${b}.jsonl.zst`), "opaque");
  else write(f.directory, b, [meta(b, base)]);
  const result = await pruneSnapshotReasoning(f.directory);
  expect(result.skippedReason).toBeString();
  expect(result.files).toBe(0);
  expect(readFileSync(f.file)).toEqual(f.before);
});

test("does not follow a linked sessions directory", async () => {
  const f = fixture(a, [meta(a), row("response_item", reasoning("old")), compact("latest")]);
  const parent = mkdtempSync(join(tmpdir(), "snapshot-session-link-")); directories.push(parent);
  const link = join(parent, "sessions"); symlinkSync(f.directory, link);
  expect((await pruneSnapshotReasoning(link)).skippedReason).toBeString();
  expect(readFileSync(f.file)).toEqual(f.before);
});
