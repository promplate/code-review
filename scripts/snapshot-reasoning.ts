// Compact checkpoints replace model history, but paginated forks still address old
// rollout prefixes by byte offset and ordinal. Only use this on an archive copy.
import { closeSync, createReadStream, openSync, readdirSync, lstatSync, utimesSync, writeSync } from "node:fs";
import { basename, join } from "node:path";

type Position = { thread_id: string; end_byte_offset: number; end_ordinal_exclusive: number };
type Checkpoint = { start: number; end: number; complete: boolean };
type Rollout = {
  path: string; id: string; base?: Position; ends: number[];
  checkpoints: Checkpoint[]; keepFrom: number; atime: number; mtime: number;
};
type PruningResult = { files: number; records: number; bytesRemoved: number; skippedReason?: string };
type Span = { start: number; end: number };
class UnsupportedHistory extends Error {}
const decode = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const rolloutName = new RegExp(`^rollout-.+-(${uuid})\\.jsonl$`, "i");
const object = (value: any): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);
const integer = (value: any) => Number.isSafeInteger(value) && value >= 0;
const optional = (value: any, valid: (value: any) => boolean) => value == null || valid(value);
const string = (value: any) => typeof value === "string";

function contentItem(item: any): boolean {
  if (!object(item)) return false;
  switch (item.type) {
    case "input_text": return string(item.text);
    case "output_text": return string(item.text) && optional(item.annotations, Array.isArray) && optional(item.logprobs, Array.isArray);
    case "input_image": return (string(item.image_url) || string(item.file_id))
      && optional(item.detail, value => ["auto", "low", "high", "original"].includes(value));
    case "input_audio": return string(item.audio_url) || string(item.file_id);
    default: return false;
  }
}

function toolOutput(value: any): boolean {
  return string(value) || Array.isArray(value) && value.every(part => object(part)
    && (part.type === "encrypted_content" ? string(part.encrypted_content) : part.type !== "output_text" && contentItem(part)));
}

function checkpointItem(item: any): boolean {
  if (!object(item) || !string(item.type)) return false;
  if (!optional(item.id, string) || !optional(item.encrypted_content, string)) return false;
  switch (item.type) {
    case "message": return string(item.role) && Array.isArray(item.content) && item.content.every(contentItem)
      && optional(item.status, string) && optional(item.phase, value => ["commentary", "partial_answer", "final_answer"].includes(value));
    case "reasoning": return Array.isArray(item.summary)
      && item.summary.every((part: any) => object(part) && part.type === "summary_text" && string(part.text))
      && optional(item.content, value => Array.isArray(value) && value.every(part => object(part) && ["reasoning_text", "text"].includes(part.type) && string(part.text)));
    case "compaction": case "compaction_summary": return string(item.encrypted_content);
    case "function_call": case "custom_tool_call": return string(item.name) && string(item.call_id)
      && string(item.type === "function_call" ? item.arguments : item.input)
      && optional(item.namespace, string) && optional(item.status, string)
      && optional(item.encrypted_function_args, value => Array.isArray(value) && value.every(string));
    case "function_call_output": case "custom_tool_call_output": return toolOutput(item.output)
      && (item.type === "custom_tool_call_output" ? string(item.call_id) : optional(item.call_id, string))
      && optional(item.name, string) && optional(item.namespace, string);
    case "agent_message": return string(item.author) && string(item.recipient) && Array.isArray(item.content)
      && item.content.every((part: any) => object(part) && (part.type === "input_text" ? string(part.text)
        : part.type === "encrypted_content" && string(part.encrypted_content)));
    case "additional_tools": return string(item.role) && Array.isArray(item.tools);
    case "context_compaction": case "compaction_trigger": return true;
    default: return false;
  }
}

// Codex skips a `compacted` record it cannot deserialize, which revives the pre-compaction
// reasoning that pruning already erased. The checks below mirror the codex-rs 0.171.0 wire
// structs: unknown fields pass (serde ignores them), known fields must carry their wire
// type, and fields without a serde default must be present. Compound shapes (RetainedSource,
// TokenUsage bodies, enums) are only checked for their JSON kind.
const flag = (value: any) => typeof value === "boolean";
const signed = (value: any) => Number.isSafeInteger(value);
const nullable = (valid: (value: any) => boolean) => (value: any) => value == null || valid(value);
const wire = (value: any, schema: Record<string, (field: any) => boolean>, required: string[] = []) =>
  object(value) && required.every(key => key in value)
  && Object.entries(value).every(([key, field]) => !(key in schema) || schema[key](field));

function harnessMetadata(value: any): boolean {
  return wire(value, {
    history_sequence: nullable(integer), sampled_through_sequence: nullable(integer), user_input_order: nullable(integer),
    fallback_token_limit_override: nullable(integer), delivered_assistant_message: nullable(string), compaction_model_hash: nullable(string),
    realtime_handoff: object, realtime_session_input: object, guardian_retained_omissions: object, sender_user_messages: object,
    image_replay_sources: Array.isArray, guardian_sources: Array.isArray, guardian_review_ids: Array.isArray,
    realtime_session_end_input: flag, guardian_source_order_guidance: flag, additional_context_tool_output: flag, client_authored: flag,
    retain_across_windows: nullable(flag), retain_in_children: nullable(flag), tool_audio_budget_applied: flag,
    delivered_assistant_message_incomplete: flag, harness_authored_configuration: flag, compaction_without_file_error_sources: flag,
    compaction_output: flag, inherited_user_message: flag,
  });
}

function resumeMetadata(value: any): boolean {
  return wire(value, {
    next_item_ordinal: nullable(integer), observation_clock_floor_ms: nullable(signed), last_started_turn_id: nullable(string),
    rejected_audio_file_ids: (field: any) => Array.isArray(field) && field.every(string),
    dynamic_tools: object, turn_attribution: object,
    previous_turn_settings: (field: any) => wire(field, { model: string, comp_hash: nullable(string), realtime_active: nullable(flag) }, ["model"]),
  });
}

function retainedContext(value: any): boolean {
  return wire(value, {
    accepted_file_audio: object, verified_answers: Array.isArray, user_messages: Array.isArray, assistant_messages: Array.isArray,
    sender_deliveries: Array.isArray, message_retention: object, incomplete: flag, user_messages_incomplete: flag,
    assistant_messages_incomplete: flag, next_order: integer,
  }, ["verified_answers", "incomplete"]);
}

function tokenUsageRecord(value: any): boolean {
  return wire(value, {
    thread_id: string, turn_id: string, session_id: string, root_turn_id: string, response_id: string,
    usage: object, turn_token_usage: object, thread_token_usage: object,
  }, ["thread_id", "turn_id", "session_id", "root_turn_id", "response_id", "usage", "turn_token_usage", "thread_token_usage"]);
}

function completeCheckpoint(payload: Record<string, any>): boolean {
  const history = payload.replacement_history, metadata = payload.replacement_history_metadata;
  return string(payload.message) && integer(payload.window_number)
    && Array.isArray(history) && history.every(checkpointItem)
    && optional(metadata, value => Array.isArray(value) && value.length === history.length && value.every(harnessMetadata))
    && optional(payload.guardian_history, value => Array.isArray(value) && value.every(checkpointItem))
    && [payload.first_window_id, payload.previous_window_id, payload.compaction_response_id].every(value => optional(value, string))
    && optional(payload.window_id, value => string(value) || integer(value))
    && optional(payload.retained_context, retainedContext) && optional(payload.resume_metadata, resumeMetadata)
    && optional(payload.latest_token_usage_record, tokenUsageRecord);
}

async function* lines(path: string): AsyncGenerator<Buffer> {
  let parts: Buffer[] = [];
  for await (const chunk of createReadStream(path)) {
    let start = 0, end: number;
    while ((end = chunk.indexOf(10, start)) !== -1) {
      const part = chunk.subarray(start, end + 1);
      yield parts.length ? Buffer.concat([...parts, part]) : part;
      parts = []; start = end + 1;
    }
    if (start < chunk.length) parts.push(chunk.subarray(start));
  }
  if (parts.length) throw new UnsupportedHistory("an incomplete rollout record");
}

function paths(directory: string): string[] {
  if (!lstatSync(directory).isDirectory()) throw new UnsupportedHistory("a linked or unsupported sessions directory");
  const result: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new UnsupportedHistory("a linked session entry");
    if (entry.isDirectory()) result.push(...paths(path));
    else if (entry.name.endsWith(".jsonl")) {
      if (!entry.isFile() || !rolloutName.test(entry.name)) throw new UnsupportedHistory("an unsupported rollout filename");
      result.push(path);
    } else if (entry.name.includes("rollout-")) throw new UnsupportedHistory("an unsupported rollout format");
  }
  return result;
}

async function scan(path: string): Promise<Rollout> {
  const id = rolloutName.exec(basename(path))![1].toLowerCase();
  const stat = lstatSync(path);
  const rollout: Rollout = { path, id, ends: [0], checkpoints: [], keepFrom: Infinity, atime: stat.atimeMs / 1000, mtime: stat.mtimeMs / 1000 };
  let start = 0;
  try {
    for await (const raw of lines(path)) {
      const record = JSON.parse(decode.decode(raw)), payload = record?.payload;
      if (!object(record) || !string(record.timestamp) || !string(record.type) || !object(payload)
        || !optional(record.ordinal, integer)) throw new UnsupportedHistory("an unsupported rollout record");
      if (start === 0) {
        if (record.type !== "session_meta" || payload.history_mode !== "paginated") throw new UnsupportedHistory("a legacy or unsupported history mode");
        if (payload.history_base != null) {
          const base = payload.history_base;
          if (!object(base) || typeof base.thread_id !== "string" || !integer(base.end_byte_offset) || !integer(base.end_ordinal_exclusive)) {
            throw new UnsupportedHistory("an invalid history base");
          }
          rollout.base = base as Position;
        }
      }
      const end = start + raw.length;
      if (record.type === "compacted") rollout.checkpoints.push({
        start, end, complete: completeCheckpoint(payload),
      });
      // Rollback can make an older checkpoint current. Leave the snapshot alone
      // rather than reproduce Codex's turn-boundary reconstruction here.
      if (record.type === "event_msg" && payload.type === "thread_rolled_back") throw new UnsupportedHistory("a rolled-back history");
      rollout.ends.push(end); start = end;
    }
    if (!start) throw new UnsupportedHistory("an empty rollout");
    return rollout;
  } finally { utimesSync(path, rollout.atime, rollout.mtime); }
}

function protectHistories(rollouts: Map<string, Rollout>) {
  const visited = new Set<string>(), visiting = new Set<string>();
  function validate(rollout: Rollout) {
    if (visited.has(rollout.id)) return;
    if (visiting.has(rollout.id)) throw new UnsupportedHistory("a cyclic history base");
    visiting.add(rollout.id);
    if (rollout.base) {
      const parent = rollouts.get(rollout.base.thread_id);
      if (!parent) throw new UnsupportedHistory("a missing parent rollout");
      const count = parent.ends.indexOf(rollout.base.end_byte_offset);
      if (count < 0 || (parent.base?.end_ordinal_exclusive ?? 0) + count !== rollout.base.end_ordinal_exclusive) {
        throw new UnsupportedHistory("an invalid history position");
      }
      validate(parent);
    }
    visiting.delete(rollout.id); visited.add(rollout.id);
  }
  for (const rollout of rollouts.values()) validate(rollout);

  function protect(rollout: Rollout, end: number) {
    const checkpoint = rollout.checkpoints.findLast(item => item.end <= end);
    // Codex carries requires_full_replay through the whole lineage after an
    // incomplete checkpoint; an older parent's checkpoint cannot bound it.
    if (checkpoint && !checkpoint.complete) throw new UnsupportedHistory("an incomplete compaction checkpoint");
    const start = checkpoint?.start ?? 0;
    rollout.keepFrom = Math.min(rollout.keepFrom, start);
    if (!start && rollout.base) protect(rollouts.get(rollout.base.thread_id)!, rollout.base.end_byte_offset);
  }
  for (const rollout of rollouts.values()) {
    protect(rollout, rollout.ends.at(-1)!);
    // Preserve every recorded fork point, including a child's inherited prefix
    // when that child has since written its own complete checkpoint.
    if (rollout.base) protect(rollouts.get(rollout.base.thread_id)!, rollout.base.end_byte_offset);
  }
}

// The input has already passed JSON.parse. Locate values without reserializing
// IDs, numeric metadata, escaped strings or any unrelated checkpoint contents.
function whitespace(text: string, at: number) {
  while (/\s/.test(text[at] ?? "")) at++;
  return at;
}
function valueEnd(text: string, start: number) {
  let depth = 0;
  for (let at = start; at < text.length; at++) {
    const char = text[at];
    if (char === '"') {
      for (at++; at < text.length; at++) {
        if (text[at] === "\\") at++;
        else if (text[at] === '"') break;
      }
      if (!depth) return at + 1;
    } else if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") {
      if (!depth) return at;
      if (--depth === 0) return at + 1;
    } else if (!depth && (char === "," || /\s/.test(char))) return at;
  }
  return text.length;
}
function* members(text: string, span: Span): Generator<[string | number, Span]> {
  const isObject = text[span.start] === "{";
  let at = whitespace(text, span.start + 1), index = 0;
  while (at < span.end - 1) {
    let key: string | number = index++;
    if (isObject) {
      const end = valueEnd(text, at);
      key = JSON.parse(text.slice(at, end));
      at = whitespace(text, whitespace(text, end) + 1);
    }
    const end = valueEnd(text, at);
    yield [key, { start: at, end }];
    at = whitespace(text, end);
    if (text[at] === ",") at = whitespace(text, at + 1);
    else break;
  }
}
function field(text: string, span: Span, name: string) {
  // Last value wins in JSON.parse; an earlier duplicate must not redirect edits.
  let found: Span | undefined;
  for (const [key, value] of members(text, span)) if (key === name) found = value;
  return found;
}

function pruneLine(raw: Buffer): { bytes: Buffer; removed: number } | undefined {
  const text = decode.decode(raw), record = JSON.parse(text), payload = record.payload;
  if (record.type !== "compacted" && !(record.type === "response_item" && payload.type === "reasoning")
    && !(record.type === "event_msg" && payload.type === "item_completed" && payload.item?.type === "Reasoning")) return;
  const edits: (Span & { value: string })[] = [];
  const root = { start: whitespace(text, 0), end: text.length };
  const payloadSpan = field(text, root, "payload")!;
  function reasoning(span: Span, item: Record<string, any>, completed = false) {
    for (const [key, value] of members(text, span)) {
      let replacement: string | undefined;
      if (completed) {
        if ((key === "summary_text" || key === "raw_content") && Array.isArray(item[key]) && item[key].length) replacement = "[]";
      } else if (key === "summary" && Array.isArray(item.summary) && item.summary.length) replacement = "[]";
      else if (key === "content" && Array.isArray(item.content)) replacement = "null";
      else if (key === "encrypted_content" && typeof item.encrypted_content === "string" && item.encrypted_content.length) {
        // A one- or two-character body can be shorter on disk than the null placeholder.
        replacement = value.end - value.start > 4 ? "null" : '""';
      }
      if (replacement && value.end - value.start > replacement.length) edits.push({ ...value, value: replacement });
    }
  }
  if (record.type === "response_item") reasoning(payloadSpan, payload);
  else if (record.type === "event_msg") reasoning(field(text, payloadSpan, "item")!, payload.item, true);
  else {
    for (const name of ["guardian_history", "replacement_history"]) {
      if (!Array.isArray(payload[name])) continue;
      for (const [index, span] of members(text, field(text, payloadSpan, name)!)) {
        const item = payload[name][index];
        if (object(item) && item.type === "reasoning") reasoning(span, item);
      }
    }
  }
  if (!edits.length) return;
  edits.sort((a, b) => a.start - b.start);
  const pieces: string[] = [];
  let cursor = 0;
  for (const edit of edits) { pieces.push(text.slice(cursor, edit.start), edit.value); cursor = edit.end; }
  const ending = text.endsWith("\r\n") ? "\r\n" : "\n";
  pieces.push(text.slice(cursor, -ending.length));
  const body = Buffer.from(pieces.join(""));
  const removed = raw.length - body.length - ending.length;
  if (removed <= 0) return;
  const bytes = Buffer.alloc(raw.length, 32);
  body.copy(bytes); bytes.write(ending, bytes.length - ending.length);
  return { bytes, removed };
}

export async function pruneSnapshotReasoning(sessionsDirectory: string): Promise<PruningResult> {
  const result: PruningResult = { files: 0, records: 0, bytesRemoved: 0 };
  const rollouts = new Map<string, Rollout>();
  try {
    for (const path of paths(sessionsDirectory)) {
      const rollout = await scan(path);
      if (rollouts.has(rollout.id)) throw new UnsupportedHistory("duplicate rollout identities");
      rollouts.set(rollout.id, rollout);
    }
    protectHistories(rollouts);
  } catch (error) {
    // This is an optional archive optimization, not a reason to lose a snapshot.
    // Reasons intentionally contain no session paths or conversation contents.
    result.skippedReason = error instanceof UnsupportedHistory ? error.message : "an unreadable history";
    return result;
  }
  for (const rollout of rollouts.values()) {
    if (!rollout.keepFrom) continue;
    const fd = openSync(rollout.path, "r+");
    let offset = 0, changed = false;
    try {
      for await (const raw of lines(rollout.path)) {
        if (offset >= rollout.keepFrom) break;
        const pruned = pruneLine(raw);
        if (pruned) {
          let written = 0;
          while (written < raw.length) {
            const count = writeSync(fd, pruned.bytes, written, raw.length - written, offset + written);
            if (!count) throw new Error("Could not write pruned snapshot reasoning");
            written += count;
          }
          result.records++; result.bytesRemoved += pruned.removed; changed = true;
        }
        offset += raw.length;
      }
    } finally { closeSync(fd); utimesSync(rollout.path, rollout.atime, rollout.mtime); }
    if (changed) result.files++;
  }
  return result;
}
