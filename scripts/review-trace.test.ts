import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectRollout, runTrace } from "./review-trace.mjs";

const dirs: string[] = [], servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); })));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "review-trace-")); dirs.push(dir);
  const home = join(dir, "home"), temp = join(dir, "temp"), sessions = join(home, "sessions");
  mkdirSync(sessions, { recursive: true }); mkdirSync(temp);
  const file = join(sessions, "rollout-fixture.jsonl"), since = Date.now() - 60_000;
  const env = { CODEX_HOME: home, RUNNER_TEMP: temp, REVIEW_RUN_ID: "review-run",
    REVIEW_TRACE_RELAY_URL: "http://127.0.0.1:1/trace", REVIEW_TRACE_RELAY_TOKEN: "rrt_" + "a".repeat(64),
    REVIEW_TRACE_RUN_STARTED_AT: String(since), REVIEW_TRACE_RELAY_EXPIRES_AT: String(since + 30 * 60_000) };
  const line = (offset: number, type: string, payload: unknown) => JSON.stringify({ timestamp: new Date(since + offset).toISOString(), type, payload }) + "\n";
  const turn = (turnId = "new-turn", offset = 1000) => [
    line(offset, "event_msg", { type: "task_started", turn_id: turnId }),
    line(offset + 1, "turn_context", { model: "gpt-fixture", instructions: "PRIVATE_PROMPT" }),
    line(offset + 2, "response_item", { type: "message", role: "user", content: [{ text: "PRIVATE_HISTORY" }] }),
    line(offset + 100, "response_item", { type: "reasoning", content: "PRIVATE_REASONING" }),
    line(offset + 200, "response_item", { type: "function_call", name: "exec_command", call_id: "raw-call", arguments: "PRIVATE_ARGS" }),
    line(offset + 201, "event_msg", { type: "token_count", info: { last_token_usage: { input_tokens: 10, cached_input_tokens: 3, output_tokens: 4, reasoning_output_tokens: 2 }, total_token_usage: { input_tokens: 99999 } } }),
    line(offset + 202, "event_msg", { type: "exec_command_begin", call_id: "raw-call", command: "PRIVATE_ARGS" }),
    line(offset + 300, "event_msg", { type: "exec_command_end", call_id: "raw-call", exit_code: 1, stdout: "PRIVATE_OUTPUT", stderr: "PRIVATE_ERROR" }),
    line(offset + 301, "response_item", { type: "function_call_output", call_id: "raw-call", output: "PRIVATE_OUTPUT" }),
    line(offset + 400, "response_item", { type: "message", role: "assistant", content: [{ text: "PRIVATE_COMPLETION" }] }),
    line(offset + 500, "event_msg", { type: "token_count", info: { last_token_usage: { input_tokens: 14, cached_input_tokens: 10, output_tokens: 5, reasoning_output_tokens: 3 }, total_token_usage: { input_tokens: 100013 } } }),
    line(offset + 600, "event_msg", { type: "task_complete", last_agent_message: "PRIVATE_COMPLETION" }),
  ].join("");
  writeFileSync(file, line(-1000, "session_meta", { id: "raw-session", base_instructions: { text: "PRIVATE_SYSTEM" }, email: "private@example.test" }) + turn());
  return { dir, file, home, temp, sessions, since, line, turn, env, state: () => JSON.parse(readFileSync(join(temp, "review-trace/state.json"), "utf8")) };
}

async function receiver(status = 202, headers: Record<string, string> = {}) {
  const received: { headers: Record<string, unknown>; body: string }[] = [];
  let currentStatus = status;
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    received.push({ headers: req.headers, body });
    res.writeHead(currentStatus, headers); res.end("PRIVATE_UPSTREAM_ERROR");
  });
  servers.push(server);
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address() as { port: number };
  return { received, url: `http://127.0.0.1:${address.port}/trace`, status: (value: number) => { currentStatus = value; } };
}

test("rollout projection omits prompts, reasoning, tool bodies and cumulative historical usage", async () => {
  const f = fixture(), events = await collectRollout(f.file, { since: f.since });
  expect(events.map(e => e.kind)).toEqual(["generation", "generation", "tool", "turn"]);
  expect(events.filter(e => e.kind === "generation").map(e => e.usage)).toEqual([
    { inputTokens: 10, cachedInputTokens: 3, outputTokens: 4, reasoningOutputTokens: 2 },
    { inputTokens: 14, cachedInputTokens: 10, outputTokens: 5, reasoningOutputTokens: 3 },
  ]);
  expect(events.find(e => e.kind === "tool")).toMatchObject({ status: "error", toolName: "exec_command", startedAt: f.since + 1202, endedAt: f.since + 1301 });
  for (const event of events) for (const key of ["eventId", "sessionId", "turnId", ...(event.callId ? ["callId"] : [])]) expect(event[key]).toMatch(/^[a-f0-9]{64}$/);
  expect(new Set(events.map(e => e.turnId)).size).toBe(1);
  expect(JSON.stringify(events)).not.toMatch(/PRIVATE_|raw-session|raw-call|new-turn|99999|100013|private@example/);
});

test("restore baseline and cutoff exclude previous runs, while new turns in the restored session remain collectable", async () => {
  const f = fixture(), target = await receiver(); f.env.REVIEW_TRACE_RELAY_URL = target.url;
  await runTrace({ env: f.env, mode: "init" });
  appendFileSync(f.file, f.turn("second-turn", 5000));
  await runTrace({ env: f.env, hook: { transcript_path: f.file } });
  const body = JSON.parse(target.received[0].body);
  expect(body.events).toHaveLength(4);
  expect(new Set(body.events.map(e => e.turnId)).size).toBe(1);
  expect(body.events.every(e => e.startedAt >= f.since + 5000)).toBe(true);
  expect(f.state().pending).toEqual([]);
  await runTrace({ env: f.env, hook: { transcript_path: f.file }, now: () => Date.now() + 10_000 });
  expect(target.received).toHaveLength(1);
  const other = join(f.sessions, "rollout-fork.jsonl");
  writeFileSync(other, f.line(-2000, "session_meta", { id: "fork-session" }) + f.turn("inherited", -1500) + f.turn("fresh", 9000));
  const fresh = await collectRollout(other, { since: f.since });
  expect(fresh).toHaveLength(4);
  expect(fresh.every(e => e.startedAt >= f.since + 9000)).toBe(true);
});

test.each([408, 500])("HTTP %i retains only safe metadata and retries the same event IDs after recovery", async status => {
  const f = fixture(), target = await receiver(status); f.env.REVIEW_TRACE_RELAY_URL = target.url;
  await runTrace({ env: f.env, hook: { transcript_path: f.file } });
  expect(f.state().pending).toHaveLength(4);
  expect(JSON.stringify(f.state())).not.toMatch(/PRIVATE_|rrt_|raw-session|private@example/);
  expect(target.received[0].headers.authorization).toBe(`Bearer ${f.env.REVIEW_TRACE_RELAY_TOKEN}`);
  target.status(202);
  await runTrace({ env: f.env, hook: { transcript_path: f.file }, now: () => Date.now() + 10_000 });
  expect(target.received).toHaveLength(2);
  expect(target.received[1].body).toBe(target.received[0].body);
  expect(f.state().pending).toEqual([]);
  expect(f.state().sent).toHaveLength(4);
});

test("401 revokes further export and expired credentials never make a request", async () => {
  const f = fixture(), target = await receiver(401); f.env.REVIEW_TRACE_RELAY_URL = target.url;
  await runTrace({ env: f.env, hook: { transcript_path: f.file } });
  expect(f.state().stopped).toBe(true);
  await runTrace({ env: f.env, mode: "flush", now: () => Date.now() + 10_000 });
  expect(target.received).toHaveLength(1);
  const expired = fixture(); expired.env.REVIEW_TRACE_RELAY_URL = target.url;
  expired.env.REVIEW_TRACE_RELAY_EXPIRES_AT = String(Date.now() - 1);
  await runTrace({ env: expired.env, hook: { transcript_path: expired.file } });
  expect(target.received).toHaveLength(1);
  expect(expired.state().stopped).toBe(true);
});

test("429 honors Retry-After and the poisoned response body never reaches state or logs", async () => {
  const f = fixture(), target = await receiver(429, { "Retry-After": "120" }); f.env.REVIEW_TRACE_RELAY_URL = target.url;
  const start = Date.now();
  await runTrace({ env: f.env, hook: { transcript_path: f.file }, now: () => start });
  await runTrace({ env: f.env, hook: { transcript_path: f.file }, now: () => start + 60_000 });
  expect(target.received).toHaveLength(1);
  expect(f.state().retryAt).toBe(start + 120_000);
  expect(JSON.stringify(f.state())).not.toContain("PRIVATE_UPSTREAM_ERROR");
  target.status(202);
  await runTrace({ env: f.env, hook: { transcript_path: f.file }, now: () => start + 121_000 });
  expect(target.received).toHaveLength(2);
});

test("redirects never forward the relay bearer to another destination", async () => {
  const f = fixture(), destination = await receiver(), redirect = await receiver(302, { Location: destination.url });
  f.env.REVIEW_TRACE_RELAY_URL = redirect.url;
  await runTrace({ env: f.env, hook: { transcript_path: f.file } });
  expect(redirect.received).toHaveLength(1); expect(destination.received).toHaveLength(0);
  expect(f.state().pending).toHaveLength(4);
});

test("Stop before terminal rollout stays incomplete; final flush distinguishes abort from missing outcome", async () => {
  const f = fixture();
  writeFileSync(f.file, f.line(0, "session_meta", { id: "session" })
    + f.line(1, "event_msg", { type: "task_started", turn_id: "turn" })
    + f.line(2, "turn_context", { model: "sk-sensitive-value" })
    + f.line(3, "response_item", { type: "function_call", call_id: "call", name: "bad name PRIVATE_TOOL", arguments: "PRIVATE_ARGS" }));
  expect(await collectRollout(f.file, { since: f.since })).toEqual([]);
  const incomplete = await collectRollout(f.file, { since: f.since, finalize: true });
  expect(incomplete.map(e => e.status)).toEqual(["unknown", "unknown", "unknown"]);
  expect(incomplete.find(e => e.kind === "tool").toolName).toBe("unknown");
  expect(JSON.stringify(incomplete)).not.toMatch(/sk-sensitive|PRIVATE_/);
  appendFileSync(f.file, f.line(4, "event_msg", { type: "turn_aborted", reason: "PRIVATE_ERROR" }));
  expect((await collectRollout(f.file, { since: f.since })).find(e => e.kind === "turn").status).toBe("aborted");
});

test("unsafe transcript paths are ignored and even a polluted local retry queue is projected again", async () => {
  const f = fixture(), target = await receiver(500); f.env.REVIEW_TRACE_RELAY_URL = target.url;
  const outside = join(f.dir, "outside.jsonl"); writeFileSync(outside, readFileSync(f.file));
  await runTrace({ env: f.env, hook: { transcript_path: outside } }); expect(target.received).toHaveLength(0);
  await runTrace({ env: f.env, hook: { transcript_path: f.file } });
  const state = f.state(); state.pending[0].input = "PRIVATE_TAMPERED"; state.pending[0].model = "sk-PRIVATE_TAMPERED";
  writeFileSync(join(f.temp, "review-trace/state.json"), JSON.stringify(state)); target.status(202);
  await runTrace({ env: f.env, hook: { transcript_path: f.file }, now: () => Date.now() + 10_000 });
  expect(target.received.at(-1)?.body).not.toMatch(/PRIVATE_|sk-/);
});

test("partial or contradictory usage is omitted without poisoning otherwise useful events", async () => {
  const f = fixture();
  for (const counts of [{ input_tokens: 10 }, { input_tokens: 10, output_tokens: 2, cached_input_tokens: 11 },
    { input_tokens: 10, output_tokens: 2, reasoning_output_tokens: 3 }]) {
    writeFileSync(f.file, f.line(0, "session_meta", { id: "session" })
      + f.line(1, "event_msg", { type: "task_started", turn_id: "turn" })
      + f.line(2, "response_item", { type: "message", role: "assistant", content: [{ text: "PRIVATE_COMPLETION" }] })
      + f.line(3, "event_msg", { type: "token_count", info: { last_token_usage: counts } })
      + f.line(4, "event_msg", { type: "task_complete" }));
    const events = await collectRollout(f.file, { since: f.since });
    expect(events).toHaveLength(2);
    expect(events[0].kind).toBe("generation");
    expect(events[0].usage).toBeUndefined();
  }
});

test("a tool output before its execution-end event does not prematurely freeze status as unknown", async () => {
  const f = fixture();
  writeFileSync(f.file, f.line(0, "session_meta", { id: "session" })
    + f.line(1, "event_msg", { type: "task_started", turn_id: "turn" })
    + f.line(2, "response_item", { type: "function_call", name: "exec_command", call_id: "call", arguments: "PRIVATE_ARGS" })
    + f.line(3, "event_msg", { type: "token_count", info: { last_token_usage: { input_tokens: 1, output_tokens: 1 } } })
    + f.line(4, "response_item", { type: "function_call_output", call_id: "call", output: "PRIVATE_OUTPUT" }));
  expect((await collectRollout(f.file, { since: f.since })).map(e => e.kind)).toEqual(["generation"]);
  appendFileSync(f.file, f.line(5, "event_msg", { type: "exec_command_end", call_id: "call", exit_code: 1, stderr: "PRIVATE_ERROR" }));
  const events = await collectRollout(f.file, { since: f.since });
  expect(events.find(e => e.kind === "tool").status).toBe("error");
});

test.each([
  { type: "exec_command_end", call_id: "call", exit_code: 1 },
  { type: "item_completed", item: { type: "CommandExecution", id: "call", status: "failed", exit_code: 7 } },
])("tool completion before token_count preserves its outcome and the generation span", async completion => {
  const f = fixture();
  writeFileSync(f.file, f.line(0, "session_meta", { id: "session" })
    + f.line(1000, "event_msg", { type: "task_started", turn_id: "turn" })
    + f.line(1200, "response_item", { type: "function_call", name: "exec_command", call_id: "call" })
    + f.line(1300, "event_msg", completion)
    + f.line(1301, "response_item", { type: "function_call_output", call_id: "call" })
    + f.line(1302, "event_msg", { type: "token_count", info: { last_token_usage: { input_tokens: 1, output_tokens: 1 } } }));
  const events = await collectRollout(f.file, { since: f.since });
  expect(events.find(event => event.kind === "tool")?.status).toBe("error");
  expect(events[0]).toMatchObject({ kind: "generation", startedAt: f.since + 1000, endedAt: f.since + 1200 });
});

test.each(["task_failed", "task_complete"])("a failed %s without token_count retains the generation without usage", async type => {
  const f = fixture();
  writeFileSync(f.file, f.line(0, "session_meta", { id: "session" })
    + f.line(1, "event_msg", { type: "task_started", turn_id: "turn" })
    + f.line(2, "response_item", { type: "reasoning", content: "PRIVATE_REASONING" })
    + f.line(3, "event_msg", { type, error: { message: "PRIVATE_PROVIDER_ERROR" } }));
  const events = await collectRollout(f.file, { since: f.since });
  expect(events.map(e => [e.kind, e.status])).toEqual([["generation", "error"], ["turn", "error"]]);
  expect(events[0].usage).toBeUndefined(); expect(JSON.stringify(events)).not.toContain("PRIVATE_");
});

test("the collector batches within the server limit and drains the same bounded safe queue", async () => {
  const f = fixture(), target = await receiver(); f.env.REVIEW_TRACE_RELAY_URL = target.url;
  writeFileSync(f.file, f.line(0, "session_meta", { id: "session" }) + Array.from({ length: 10 }, (_, i) => f.turn(`turn-${i}`, i * 1000 + 1)).join(""));
  await runTrace({ env: f.env, hook: { transcript_path: f.file } });
  expect(JSON.parse(target.received[0].body).events).toHaveLength(32);
  expect(Buffer.byteLength(target.received[0].body)).toBeLessThanOrEqual(64 * 1024);
  expect(f.state().pending).toHaveLength(8);
  await runTrace({ env: f.env, hook: { transcript_path: f.file }, now: () => Date.now() + 10_000 });
  expect(JSON.parse(target.received[1].body).events).toHaveLength(8);
  expect(f.state().pending).toEqual([]); expect(f.state().sent).toHaveLength(40);
});
