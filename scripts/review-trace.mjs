// Hosted Review metadata exporter. No Langfuse SDK, credentials, prompts or tool
// bodies enter this transport. The Worker still treats every field as untrusted.
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, realpath, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const MAX_EVENTS = 4096, MAX_FILES = 512, MAX_TRANSCRIPT_BYTES = 128 * 1024 * 1024;
const REQUEST_SPACING = 5500, REQUEST_TIMEOUT = 4000, FLUSH_BUDGET = 15000;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const id = (value) => typeof value === "string" && value.length > 0 && value.length <= 256 ? value : undefined;
const timestamp = (value) => typeof value === "number" ? value : /^\d+$/.test(value ?? "") ? Number(value) : Date.parse(value);
const label = (value) => typeof value === "string" && /^[a-zA-Z][a-zA-Z0-9_.:/-]{0,95}$/.test(value)
  && !/(?:^|[/.:])(?:sk-|pk-|eyJ[A-Za-z0-9])|(?:secret|token|password|api[_-]?key)[=:]/i.test(value) ? value : undefined;
const inside = (root, file) => { const rel = relative(root, file); return rel && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel); };

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
export async function collectRollout(file, { since, baseline = 0, finalize = false, stopped = false }) {
  const events = [];
  let session, turn, bytes = 0;
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
      if (call.status !== undefined || status !== undefined || finalize || (stopped && call.end !== undefined))
        emit("tool", call.id, call.start, call.end ?? ts, call.status ?? "unknown",
        { callId: hash(`call:${session}:${turn.id}:${call.id}`), toolName: call.name });
    }
    if (status !== undefined) emit("turn", "final", turn.start, ts, status, turn.model ? { model: turn.model } : {});
    turn = undefined;
  };
  const input = createReadStream(file, { encoding: "utf8", end: MAX_TRANSCRIPT_BYTES - 1 });
  try {
    for await (const raw of createInterface({ input, crlfDelay: Infinity })) {
      const offset = bytes;
      bytes += Buffer.byteLength(raw) + 1;
      if (bytes > MAX_TRANSCRIPT_BYTES) break;
      // Bound a line before parsing. Large prompt/tool records carry no required metadata.
      if (raw.length > 1_048_576) continue;
      let line;
      try { line = JSON.parse(raw); } catch { continue; }
      const p = line?.payload;
      if (!p || typeof p !== "object") continue;
      if (line.type === "session_meta") { session ??= id(p.id); continue; }
      const ts = timestamp(line.timestamp);
      if (offset < baseline || !Number.isFinite(ts) || ts < since) continue;
      if (line.type === "event_msg" && p.type === "task_started") {
        finish(ts, finalize ? "unknown" : undefined);
        const turnId = id(p.turn_id);
        if (turnId) turn = { id: turnId, start: ts, last: ts, stepStart: ts, step: 0, activity: false, tools: new Map() };
        continue;
      }
      if (!turn) continue;
      turn.last = ts;
      if (line.type === "turn_context") { turn.model = label(p.model) ?? turn.model; continue; }
      if (line.type === "response_item") {
        if (p.type === "reasoning" || (p.type === "message" && p.role === "assistant")) turn.activity = true;
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
            call.end = Math.max(call.end ?? ts, ts);
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
      } else if (p.type === "task_complete") finish(ts, p.error != null ? "error" : "success");
      else if (p.type === "turn_aborted") finish(ts, "aborted");
      else if (p.type === "task_failed" || p.type === "turn_failed") finish(ts, "error");
      else if (typeof p.type === "string") {
        const item = p.type === "item_completed" ? p.item : undefined;
        const call = turn.tools.get(item?.id ?? p.call_id);
        if (!call) continue;
        if (p.type.endsWith("_begin")) call.start = ts;
        if (item || p.type.endsWith("_end")) {
          const outcome = item ?? p;
          call.end = ts;
          call.status = outcome.status === "failed" || outcome.status === "declined" || outcome.error != null || outcome.codex_error_info != null
            || (typeof outcome.exit_code === "number" && outcome.exit_code !== 0) ? "error"
            : outcome.status === "completed" || outcome.status === "success" || outcome.exit_code === 0 ? "success" : "unknown";
          if (!turn.activity) turn.stepStart = Math.max(turn.stepStart, ts);
        }
      }
    }
    // Stop can precede task_complete. Only EXIT flush marks unfinished spans;
    // it never guesses that a missing terminal event means success.
    if (turn && finalize) {
      finish(turn.last, "unknown");
    } else if (turn) finish(turn.last, undefined);
  } finally { input.destroy(); }
  return events;
}

async function rolloutFiles(root) {
  const result = [];
  async function walk(dir, depth) {
    if (depth > 4 || result.length >= MAX_FILES) return;
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (result.length >= MAX_FILES) break;
      const file = join(dir, entry.name);
      if (entry.isDirectory()) await walk(file, depth + 1);
      else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) result.push(file);
    }
  }
  await walk(root, 0);
  return result;
}

const emptyState = (scope) => ({ version: 1, scope, baseline: {}, sent: [], pending: [], retryAt: 0, failures: 0, stopped: false });
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
export async function runTrace({ env = process.env, hook = {}, mode = "hook", now = Date.now, send = fetch } = {}) {
  const config = configuration(env);
  if (!config) return;
  await mkdir(config.directory, { recursive: true, mode: 0o700 });
  const lock = join(config.directory, "lock"), stateFile = join(config.directory, "state.json");
  try { await mkdir(lock, { mode: 0o700 }); } catch {
    // A killed hook must not disable future collection forever.
    if (now() - (await stat(lock).catch(() => ({ mtimeMs: now() }))).mtimeMs > 60_000) await rm(lock, { recursive: true, force: true });
    return;
  }
  try {
    const state = await loadState(stateFile, config.scope);
    if (mode === "init") {
      for (const file of await rolloutFiles(config.sessions)) state.baseline[relative(config.sessions, file)] = (await stat(file)).size;
      await saveState(stateFile, state);
      return;
    }
    if (state.stopped || now() >= config.expiresAt) { state.stopped = true; await saveState(stateFile, state); return; }
    const root = await realpath(config.sessions).catch(() => undefined);
    if (!root) return;
    const files = mode === "flush" ? await rolloutFiles(root) : typeof hook.transcript_path === "string" ? [hook.transcript_path] : [];
    const known = new Set([...state.sent, ...state.pending.map((event) => event.eventId)]);
    for (const candidate of files) {
      const file = await realpath(candidate).catch(() => undefined);
      if (!file || !inside(root, file)) continue;
      const events = await collectRollout(file, { since: config.since, baseline: state.baseline[relative(root, file)] ?? 0,
        finalize: mode === "flush", stopped: hook.hook_event_name === "Stop" });
      for (const event of events) {
        if (known.size >= MAX_EVENTS) break;
        if (!known.has(event.eventId)) { state.pending.push(event); known.add(event.eventId); }
      }
    }
    await saveState(stateFile, state);
    const deadline = now() + (mode === "flush" ? FLUSH_BUDGET : REQUEST_TIMEOUT);
    while (state.pending.length && now() < config.expiresAt && now() < deadline && !state.stopped) {
      const delay = Math.max(0, state.retryAt - now());
      if (delay) {
        if (mode !== "flush" || now() + delay + REQUEST_TIMEOUT > deadline) break;
        await new Promise((done) => setTimeout(done, delay));
      }
      const remaining = Math.min(config.expiresAt, deadline) - now();
      if (remaining <= 0) break;
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
        await response.body?.cancel();
      } catch { state.retryAt = now() + Math.min(60_000, Math.max(REQUEST_SPACING, 1000 * 2 ** Math.min(++state.failures, 6))); }
      await saveState(stateFile, state);
      if (mode !== "flush") break;
    }
  } finally { await rm(lock, { recursive: true, force: true }); }
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
