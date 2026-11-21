// Hosted Review metadata exporter. No Langfuse SDK, credentials, prompts or tool
// bodies enter this transport. The Worker still treats every field as untrusted.
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, opendir, readFile, readdir, realpath, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_EVENTS = 4096, MAX_FILES = 512, MAX_TRANSCRIPT_BYTES = 128 * 1024 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;
const REQUEST_SPACING = 5500, REQUEST_TIMEOUT = 4000, FLUSH_BUDGET = 15000;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const id = (value) => typeof value === "string" && value.length > 0 && value.length <= 256 ? value : undefined;
const timestamp = (value) => typeof value === "number" ? value : /^\d+$/.test(value ?? "") ? Number(value) : Date.parse(value);
const label = (value) => typeof value === "string" && /^[a-zA-Z][a-zA-Z0-9_.:/-]{0,95}$/.test(value)
  && !/(?:^|[/.:])(?:sk-|pk-|eyJ[A-Za-z0-9])|(?:secret|token|password|api[_-]?key)[=:]/i.test(value) ? value : undefined;
const inside = (root, file) => { const rel = relative(root, file); return rel && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel); };

function scanBudget(milliseconds, readStream = createReadStream) {
  const deadline = performance.now() + milliseconds;
  return { bytes: MAX_TRANSCRIPT_BYTES, readStream, signal: AbortSignal.timeout(Math.max(1, Math.ceil(milliseconds))),
    remaining: () => Math.max(0, deadline - performance.now()) };
}

// Never accumulate an unbounded prompt/output line. Only complete newline-ended
// records are parsed, so a concurrent append or an exhausted budget cannot invent
// a terminal event from a partial record. The byte budget is shared across files.
async function* rolloutLines(file, start, limit, budget) {
  const length = Math.min(limit, budget.bytes);
  if (length <= 0 || budget.remaining() <= 0) return;
  const input = budget.readStream(file, { start, end: start + length - 1, highWaterMark: 64 * 1024, signal: budget.signal });
  let parts = [], size = 0, discarded = false;
  try {
    for await (const chunk of input) {
      budget.bytes -= chunk.length;
      let offset = 0;
      while (offset < chunk.length && budget.remaining() > 0) {
        const newline = chunk.indexOf(10, offset), end = newline < 0 ? chunk.length : newline;
        const part = chunk.subarray(offset, end);
        size += part.length;
        if (size > MAX_LINE_BYTES) { parts = []; discarded = true; }
        else if (!discarded) parts.push(part);
        if (newline < 0) break;
        if (!discarded) {
          let line;
          try { line = JSON.parse(Buffer.concat(parts, size).toString("utf8")); } catch { /* An incomplete or non-JSON record carries no metadata. */ }
          if (line) yield line;
        }
        parts = []; size = 0; discarded = false; offset = newline + 1;
      }
      if (budget.remaining() <= 0) break;
    }
  } catch (error) { if (!budget.signal.aborted) throw error; }
  finally { input.destroy(); }
}

function toolOutcome(value) {
  const result = value.result?.Ok ?? value.result;
  if (value.status === "aborted" || value.status === "interrupted") return "aborted";
  if (value.status === "failed" || value.status === "declined" || value.error != null || value.codex_error_info != null
    || value.result?.Err != null || result?.isError === true || result?.is_error === true || value.success === false
    || (typeof value.exit_code === "number" && value.exit_code !== 0)) return "error";
  if (value.status === "completed" || value.status === "success" || value.exit_code === 0 || value.success === true
    || value.result?.Ok != null) return "success";
  return "unknown";
}

// These are rollout TurnItem types, not the differently shaped exec --json
// stream. In Codex 0.171 paginated rollouts only item_completed is durable; its
// started_at_ms supplies timing even when Code Mode has no model function_call.
function itemToolName(item) {
  switch (item?.type) {
    case "CommandExecution": return "exec_command";
    case "McpToolCall": return label(item.tool) ?? "mcp_tool";
    case "DynamicToolCall": return label(item.tool) ?? "dynamic_tool";
    case "CollabAgentToolCall": return label(item.tool) ?? "agent_tool";
    case "FileChange": return "apply_patch";
    case "WebSearch": return "web_search";
    case "ImageView": return "view_image";
    case "ImageGeneration": return "image_generation";
    default: return undefined;
  }
}

function legacyToolName(event) {
  if (/^exec_command_(?:begin|end)$/.test(event.type)) return "exec_command";
  if (/^mcp_tool_call_(?:begin|end)$/.test(event.type)) return label(event.invocation?.tool) ?? "mcp_tool";
  if (/^patch_apply_(?:begin|end)$/.test(event.type)) return "apply_patch";
  if (/^web_search_(?:begin|end)$/.test(event.type)) return "web_search";
  return undefined;
}

function usage(value) {
  if (!value || typeof value !== "object") return undefined;
  const valid = (n) => Number.isSafeInteger(n) && n >= 0 && n <= 100_000_000;
  if (!valid(value.input_tokens) || !valid(value.output_tokens)
    || (value.cached_input_tokens !== undefined && (!valid(value.cached_input_tokens) || value.cached_input_tokens > value.input_tokens))
    || (value.reasoning_output_tokens !== undefined && (!valid(value.reasoning_output_tokens) || value.reasoning_output_tokens > value.output_tokens))) return;
  const result = {};
  for (const [source, target] of [["input_tokens", "inputTokens"], ["cached_input_tokens", "cachedInputTokens"],
    ["output_tokens", "outputTokens"], ["reasoning_output_tokens", "reasoningOutputTokens"]]) {
    const n = value[source];
    if (valid(n)) result[target] = n;
  }
  return Object.keys(result).length ? result : undefined;
}

// Stream the rollout, retaining only allowlisted metadata. A token_count closes
// one observable generation; cumulative session totals are deliberately ignored.
// Times describe observable spans, not precise upstream HTTP request latency.
export async function collectRollout(file, { since, baseline = 0, finalize = false, stopped = false, budget = scanBudget(REQUEST_TIMEOUT) }) {
  const events = [];
  let session, turn;
  const emit = (kind, key, start, end, status, extra = {}) => {
    if (!session || !turn || events.length >= MAX_EVENTS || !Number.isFinite(start) || !Number.isFinite(end)) return;
    events.push({ eventId: hash(`${session}:${turn.id}:${kind}:${key}`), kind,
      sessionId: hash(`session:${session}`), turnId: hash(`turn:${session}:${turn.id}`),
      startedAt: start, endedAt: Math.max(start, end), status, ...extra });
  };
  const finish = (ts, status) => {
    if (!turn) return;
    if (turn.activity && status !== undefined) emit("generation", String(turn.step++), turn.stepStart, turn.firstTool ?? ts, status,
      turn.model ? { model: turn.model } : {});
    for (const call of turn.tools.values()) {
      // A response_item output may precede its execution-end event. Wait until
      // that status arrives, or until Stop/terminal/EXIT makes absence explicit.
      if (call.status !== undefined || status !== undefined || (stopped && call.end !== undefined))
        emit("tool", call.id, call.start, call.measuredEnd ?? call.end ?? ts, call.status ?? "unknown",
        { callId: hash(`call:${session}:${turn.id}:${call.id}`), toolName: call.name });
    }
    if (status !== undefined) emit("turn", "final", turn.start, ts, status, turn.model ? { model: turn.model } : {});
    turn = undefined;
  };
  // Restored history may be gigabytes long. Read its identity separately, then
  // spend the bounded scan window on bytes appended during this review run.
  if (baseline > 0) {
    for await (const line of rolloutLines(file, 0, MAX_LINE_BYTES, budget)) {
      if (line.type === "session_meta") { session = id(line.payload?.id); break; }
    }
    if (!session) return events;
  }
  for await (const line of rolloutLines(file, baseline, MAX_TRANSCRIPT_BYTES, budget)) {
    const p = line?.payload;
    if (!p || typeof p !== "object") continue;
    if (line.type === "session_meta") { session ??= id(p.id); continue; }
    const ts = timestamp(line.timestamp);
    if (!Number.isFinite(ts) || ts < since) continue;
    if (line.type === "event_msg" && ["task_started", "turn_started"].includes(p.type)) {
      finish(ts, finalize ? "unknown" : undefined);
      const turnId = id(p.turn_id);
      if (turnId) turn = { id: turnId, start: ts, last: ts, stepStart: ts, step: 0, activity: false, tools: new Map() };
      continue;
    }
    if (!turn || (id(p.turn_id) && p.turn_id !== turn.id)) continue;
    turn.last = ts;
    if (line.type === "turn_context") { turn.model = label(p.model) ?? turn.model; continue; }
    if (line.type === "response_item") {
      if (["reasoning", "agent_message"].includes(p.type) || (p.type === "message" && p.role === "assistant")) turn.activity = true;
      if (["function_call", "custom_tool_call", "local_shell_call", "web_search_call"].includes(p.type)) {
        turn.activity = true;
        const callId = id(p.call_id) ?? id(p.id);
        turn.firstTool ??= ts;
        if (callId && turn.tools.size < MAX_EVENTS) {
          const name = p.type === "local_shell_call" ? "local_shell" : p.type === "web_search_call" ? "web_search" : label(p.name) ?? "unknown";
          if (!turn.tools.has(callId)) turn.tools.set(callId, { id: callId, name, start: ts });
        }
      } else if (["function_call_output", "custom_tool_call_output"].includes(p.type)) {
        const call = turn.tools.get(id(p.call_id));
        if (call) {
          if (call.status === undefined) call.end = Math.max(call.end ?? ts, ts);
          if (!turn.activity) turn.stepStart = Math.max(turn.stepStart, ts);
        }
      }
    }
    if (line.type !== "event_msg") continue;
    if (p.type === "token_count" && turn.activity && p.info?.last_token_usage) {
      const counts = usage(p.info.last_token_usage);
      emit("generation", String(turn.step++), turn.stepStart, turn.firstTool ?? ts, "success",
        { ...(turn.model ? { model: turn.model } : {}), ...(counts ? { usage: counts } : {}) });
      turn.activity = false; turn.firstTool = undefined; turn.stepStart = ts;
    } else if (["task_complete", "turn_complete"].includes(p.type)) finish(ts, p.error != null ? "error" : "success");
    else if (p.type === "turn_aborted") finish(ts, "aborted");
    else if (p.type === "task_failed" || p.type === "turn_failed") finish(ts, "error");
    else if (typeof p.type === "string") {
      const item = ["item_started", "item_completed"].includes(p.type) ? p.item : undefined;
      const callId = id(item?.id) ?? id(p.call_id), name = item ? itemToolName(item) : legacyToolName(p);
      let call = turn.tools.get(callId);
      const measured = (value, fallback) => Number.isSafeInteger(value) && value >= turn.start && value <= ts ? value : fallback;
      const start = measured(p.started_at_ms, ts);
      if (!call && callId && name && turn.tools.size < MAX_EVENTS) {
        call = { id: callId, name, start };
        turn.tools.set(callId, call);
      }
      if (!call) continue;
      if (p.type === "item_started" || p.type.endsWith("_begin") || (item && p.started_at_ms != null)) call.start = measured(p.started_at_ms, call.start);
      if (p.type.endsWith("_begin") && p.started_at_ms == null) call.start = ts;
      if (p.type === "item_completed" || p.type.endsWith("_end")) {
        const outcome = item ?? p;
        call.measuredEnd = measured(p.completed_at_ms, call.measuredEnd);
        call.end = call.measuredEnd ?? ts;
        call.status = toolOutcome(outcome);
        if (!turn.activity) turn.stepStart = Math.max(turn.stepStart, call.end);
      }
    }
  }
  // A truncated scan cannot prove the absence of a later terminal record. Only
  // finalize when we reached EOF with budget left; future hooks may continue.
  if (turn) finish(turn.last, finalize && budget.remaining() > 0 && budget.bytes > 0 ? "unknown" : undefined);
  return events;
}

async function* rolloutFiles(root, budget, active = []) {
  const seen = new Set();
  for (const name of active) {
    const file = resolve(root, name);
    if (budget.remaining() <= 0 || seen.size >= MAX_FILES) return;
    if (inside(root, file) && !seen.has(file)) { seen.add(file); yield file; }
  }
  async function* walk(dir, depth) {
    if (depth > 4 || seen.size >= MAX_FILES || budget.remaining() <= 0) return;
    const directory = await opendir(dir).catch(() => undefined);
    if (!directory) return;
    for await (const entry of directory) {
      if (seen.size >= MAX_FILES || budget.remaining() <= 0) break;
      const file = join(dir, entry.name);
      if (entry.isDirectory()) yield* walk(file, depth + 1);
      else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl") && !seen.has(file)) {
        seen.add(file); yield file;
      }
    }
  }
  yield* walk(root, 0);
}

const emptyState = (scope) => ({ version: 1, scope, baseline: {}, active: [], sent: [], pending: [], retryAt: 0, failures: 0, stopped: false });
function storedEvent(value) {
  const digest = (item) => typeof item === "string" && /^[a-f0-9]{64}$/.test(item);
  if (!value || !digest(value.eventId) || !digest(value.sessionId) || !digest(value.turnId)
    || !["turn", "generation", "tool"].includes(value.kind) || !["success", "error", "aborted", "unknown"].includes(value.status)
    || !Number.isSafeInteger(value.startedAt) || !Number.isSafeInteger(value.endedAt) || value.endedAt < value.startedAt) return;
  const result = { eventId: value.eventId, kind: value.kind, sessionId: value.sessionId, turnId: value.turnId,
    startedAt: value.startedAt, endedAt: value.endedAt, status: value.status };
  if (digest(value.callId)) result.callId = value.callId;
  if (label(value.model)) result.model = value.model;
  if (label(value.toolName)) result.toolName = value.toolName;
  const counts = usage({ input_tokens: value.usage?.inputTokens, cached_input_tokens: value.usage?.cachedInputTokens,
    output_tokens: value.usage?.outputTokens, reasoning_output_tokens: value.usage?.reasoningOutputTokens });
  if (counts) result.usage = counts;
  return result;
}
async function loadState(file, scope) {
  try {
    if ((await stat(file)).size > 4 * 1024 * 1024) return emptyState(scope);
    const value = JSON.parse(await readFile(file, "utf8"));
    if (value.version !== 1 || value.scope !== scope || !Array.isArray(value.sent) || !Array.isArray(value.pending)) return emptyState(scope);
    return { ...emptyState(scope),
      baseline: Object.fromEntries(Object.entries(value.baseline ?? {}).filter(([, size]) => Number.isSafeInteger(size) && size >= 0).slice(0, MAX_FILES)),
      active: Array.isArray(value.active) ? value.active.filter((name) => typeof name === "string" && name.length <= 4096 && !isAbsolute(name)).slice(0, MAX_FILES) : [],
      sent: value.sent.filter((item) => typeof item === "string" && /^[a-f0-9]{64}$/.test(item)).slice(0, MAX_EVENTS),
      pending: value.pending.map(storedEvent).filter(Boolean).slice(0, MAX_EVENTS),
      retryAt: Number.isFinite(value.retryAt) ? value.retryAt : 0, failures: Math.min(6, Math.max(0, Number(value.failures) || 0)), stopped: value.stopped === true };
  } catch { return emptyState(scope); }
}
async function saveState(file, state) {
  const temporary = `${file}.${randomUUID()}`;
  await writeFile(temporary, JSON.stringify(state), { mode: 0o600, flag: "wx" });
  await rename(temporary, file);
}

function ownerExited(owner) {
  const match = /^owner-([1-9][0-9]{0,9})-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.exec(owner);
  const pid = match ? Number(match[1]) : 0;
  // Never probe process groups (0/negative IDs), malformed or out-of-range IDs.
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 0x7fffffff) return false;
  try { process.kill(pid, 0); return false; }
  catch (error) { return error.code === "ESRCH"; }
}

async function acquireLock(lock, budget, wait) {
  // The PID is bounded metadata in the unique name; do not read arbitrary marker
  // contents. A reused PID or an unverifiable legacy owner is kept conservatively.
  const owner = `owner-${process.pid}-${randomUUID()}`, candidate = `${lock}.${owner}`;
  await mkdir(candidate, { mode: 0o700 });
  try {
    await writeFile(join(candidate, owner), "", { mode: 0o600, flag: "wx" });
    while (budget.remaining() > 0) {
      // Capture the exact old marker before proving that process has exited. A
      // concurrent reclaimer cannot give a new owner this UUID. Age is never
      // evidence of process death, including when the owner is still alive.
      const entries = await readdir(lock).catch(error => error.code === "ENOENT" ? undefined : null);
      if (entries === null) return;
      let available = entries === undefined;
      if (entries?.length === 1 && ownerExited(entries[0])) {
        await unlink(join(lock, entries[0])).catch(() => {});
        try { await rmdir(lock); available = true; }
        catch (error) { if (error.code === "ENOENT") available = true; else if (error.code !== "ENOTEMPTY") return; }
      }
      // Publish a fully populated directory in one operation. Another live
      // owner makes rename fail because its directory is never empty.
      if (available && budget.remaining() > 0) {
        try { await rename(candidate, lock); return owner; }
        catch (error) { if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) return; }
      }
      // Hooks may skip a busy exporter. EXIT is the last chance to observe a
      // terminal record, so wait for the owner using the same total call budget.
      if (!wait || budget.remaining() <= 0) return;
      await new Promise(resolve => setTimeout(resolve, Math.min(50, budget.remaining())));
    }
  } finally { await rm(candidate, { recursive: true, force: true }); }
}

async function releaseLock(lock, owner) {
  await unlink(join(lock, owner)).catch(() => {});
  // If a new owner arrived after our unlink, its nonempty directory survives.
  await rmdir(lock).catch(() => {});
}

function configuration(env) {
  if (!env.REVIEW_TRACE_RELAY_URL || !env.REVIEW_TRACE_RELAY_TOKEN || !env.RUNNER_TEMP || !env.CODEX_HOME) return;
  const url = new URL(env.REVIEW_TRACE_RELAY_URL), since = timestamp(env.REVIEW_TRACE_RUN_STARTED_AT);
  const expiresAt = timestamp(env.REVIEW_TRACE_RELAY_EXPIRES_AT);
  const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.search || url.hash
    || !Number.isFinite(since) || !Number.isFinite(expiresAt) || expiresAt <= since) return;
  return { url: url.href, token: env.REVIEW_TRACE_RELAY_TOKEN, since, expiresAt,
    sessions: resolve(env.CODEX_HOME, "sessions"), directory: resolve(env.RUNNER_TEMP, "review-trace"),
    scope: hash(`${env.REVIEW_RUN_ID ?? ""}:${env.REVIEW_TRACE_RUN_STARTED_AT}`) };
}

// An ACK means the Worker durably accepted the sanitized event, not necessarily
// that Langfuse is healthy. Tokens and response bodies never enter the local queue.
export async function runTrace({ env = process.env, hook = {}, mode = "hook", now = Date.now, send = fetch,
  readStream = createReadStream, budgetMs = mode === "flush" ? FLUSH_BUDGET : REQUEST_TIMEOUT } = {}) {
  // One monotonic wall-clock budget covers setup, discovery, parsing and HTTP.
  // The injected wall clock remains useful for expiry/Retry-After tests without
  // letting a frozen clock extend the actual shutdown deadline.
  const budget = scanBudget(Math.min(mode === "flush" ? FLUSH_BUDGET : REQUEST_TIMEOUT, Math.max(1, budgetMs)), readStream);
  const config = configuration(env);
  if (!config) return;
  await mkdir(config.directory, { recursive: true, mode: 0o700 });
  const lock = join(config.directory, "lock"), stateFile = join(config.directory, "state.json");
  const owner = await acquireLock(lock, budget, mode === "flush");
  if (!owner) return;
  try {
    const state = await loadState(stateFile, config.scope);
    if (mode === "init") {
      for await (const file of rolloutFiles(config.sessions, budget)) {
        if (budget.remaining() <= 0) break;
        const info = await stat(file).catch(() => undefined);
        if (info?.isFile()) state.baseline[relative(config.sessions, file)] = info.size;
      }
      await saveState(stateFile, state);
      return;
    }
    if (state.stopped || now() >= config.expiresAt) { state.stopped = true; await saveState(stateFile, state); return; }
    const root = await realpath(config.sessions).catch(() => undefined);
    if (!root) return;
    const files = mode === "flush" ? rolloutFiles(root, budget, state.active) : typeof hook.transcript_path === "string" ? [hook.transcript_path] : [];
    const known = new Set([...state.sent, ...state.pending.map((event) => event.eventId)]);
    for await (const candidate of files) {
      // This is the relay's total per-run event allowance, including ACKs, not
      // just a pending-queue limit. Draining a batch does not reset that quota.
      if (known.size >= MAX_EVENTS || budget.remaining() <= 0 || budget.bytes <= 0 || now() >= config.expiresAt) break;
      const file = await realpath(candidate).catch(() => undefined);
      if (!file || !inside(root, file)) continue;
      const name = relative(root, file), info = await stat(file).catch(() => undefined);
      if (!info?.isFile()) continue;
      if (mode === "hook") state.active = [name, ...state.active.filter((item) => item !== name)].slice(0, MAX_FILES);
      const baseline = state.baseline[name] ?? 0;
      // Unchanged restored history needs no parsing. A truncated/replaced file
      // is filtered by timestamps rather than seeking past its new contents.
      if (info.size === baseline) continue;
      const events = await collectRollout(file, { since: config.since, baseline: info.size < baseline ? 0 : baseline, budget,
        finalize: mode === "flush", stopped: hook.hook_event_name === "Stop" });
      for (const event of events) {
        if (known.size >= MAX_EVENTS) break;
        if (!known.has(event.eventId)) { state.pending.push(event); known.add(event.eventId); }
      }
    }
    await saveState(stateFile, state);
    while (state.pending.length && now() < config.expiresAt && budget.remaining() > 0 && !state.stopped) {
      const delay = Math.max(0, state.retryAt - now());
      if (delay) {
        if (mode !== "flush" || delay + REQUEST_TIMEOUT > budget.remaining() || now() + delay >= config.expiresAt) break;
        await new Promise((done) => setTimeout(done, delay));
      }
      const remaining = Math.floor(Math.min(config.expiresAt - now(), budget.remaining()));
      if (remaining < 1) break;
      const batch = state.pending.slice(0, 32);
      while (Buffer.byteLength(JSON.stringify({ version: 1, events: batch })) > 64 * 1024) batch.pop();
      if (!batch.length) break;
      try {
        const response = await send(config.url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` },
          body: JSON.stringify({ version: 1, events: batch }), redirect: "error", signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT, remaining)) });
        if (response.status === 202) { state.sent.push(...batch.map((event) => event.eventId)); state.pending.splice(0, batch.length); state.failures = 0; state.retryAt = now() + REQUEST_SPACING; }
        else if (response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status)) state.stopped = true;
        else {
          const retry = response.headers.get("retry-after");
          const retryMs = /^\d+$/.test(retry ?? "") ? Number(retry) * 1000 : Date.parse(retry ?? "") - now();
          state.retryAt = Math.min(config.expiresAt, now() + Math.max(REQUEST_SPACING,
            Number.isFinite(retryMs) ? retryMs : Math.min(60_000, 1000 * 2 ** Math.min(++state.failures, 6))));
        }
        // Discard the response without waiting for an arbitrary upstream body
        // (or a runtime's cancellation handshake) to finish the review.
        void response.body?.cancel().catch(() => {});
      } catch { state.retryAt = now() + Math.min(60_000, Math.max(REQUEST_SPACING, 1000 * 2 ** Math.min(++state.failures, 6))); }
      await saveState(stateFile, state);
      if (mode !== "flush") break;
    }
  } finally { await releaseLock(lock, owner); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const mode = process.argv[2] === "--init" ? "init" : process.argv[2] === "--flush" ? "flush" : "hook";
    let hook = {};
    if (mode === "hook") {
      // Consume but never retain arbitrary hook tool inputs/outputs. transcript_path
      // is the only hook field used; it is confined to CODEX_HOME/sessions above.
      let input = "";
      for await (const chunk of process.stdin) { input += chunk; if (input.length > 1_048_576) break; }
      hook = JSON.parse(input);
    }
    await runTrace({ mode, hook });
  } catch { console.error("::warning::Review metadata tracing was incomplete."); }
}
