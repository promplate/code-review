import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const scripts = process.env.REVIEW_SCRIPTS_PATH || import.meta.dir;
const realJq = Bun.which("jq")!;
const realTail = Bun.which("tail")!;
const realSleep = Bun.which("sleep")!;
const realCurl = Bun.which("curl")!;
const homes: string[] = [];
const human = { login: "collaborator", type: "User" };
const bot = { login: "ci[bot]", type: "Bot" };
const check = (overrides = {}) => ({ id: 100, name: "test", status: "completed", conclusion: "success", head_sha: "head", app: { slug: "github-actions" }, ...overrides });
const frame = (event: string, body: object, delivery = event, writer = true, cursor?: string) => `id: ${cursor ?? delivery}\ndata: ${JSON.stringify({ event, delivery, writer, cursor, body: JSON.stringify({ sender: human, ...body }) })}\n\n`;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "review-events-"));
  homes.push(dir);
  writeFileSync(join(dir, "sse.jsonl"), "");
  writeFileSync(join(dir, "injected.log"), "");
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, RUNNER_TEMP: dir, CODEX_HOME: dir, GITHUB_ACTION_PATH: root, GITHUB_ENV: join(dir, "github-env"),
    GITHUB_REPOSITORY: "owner/repo", PR_NUMBER: "7", HEAD_SHA: "head", HEAD_BRANCH: "feature", GITHUB_REF: "refs/heads/main", BOT_LOGIN: "reviewer[bot]",
    CHECK_ID: "10", JOB_CHECK_RUN_ID: "11", GITHUB_RUN_ID: "12" };
  return { dir, env };
}

function executable(dir: string, name: string, content: string) {
  const path = join(dir, name);
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

function runHook(log: string, overrides = {}) {
  const setup = fixture();
  writeFileSync(join(setup.dir, "sse.jsonl"), log);
  const run = () => Bun.spawnSync(["bash", join(scripts, "review-hook.sh")], { env: { ...setup.env, ...overrides }, stdin: Buffer.from('{"hook_event_name":"Stop"}'), timeout: 3000 });
  const result = run();
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe("");
  return { ...setup, run, result, output: result.stdout.toString() };
}

function runCI(responses: { pages?: object[]; error?: string }[], events = "", args: string[] = [], extraEnv: Record<string, string> = {}) {
  const setup = fixture();
  writeFileSync(join(setup.dir, "sse.jsonl"), events);
  writeFileSync(join(setup.dir, "responses.json"), JSON.stringify(responses));
  executable(setup.dir, "gh", `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const dir = process.env.RUNNER_TEMP;
const argv = process.argv.slice(2);
appendFileSync(dir + "/gh-args", JSON.stringify(argv) + "\\n");
if (!argv.includes("--paginate")) { console.error("missing pagination"); process.exit(1); }
if (argv.includes("--slurp")) { console.error("unknown flag: --slurp"); process.exit(1); }
const countFile = dir + "/calls";
const count = existsSync(countFile) ? Number(readFileSync(countFile, "utf8")) : 0;
writeFileSync(countFile, String(count + 1));
const response = JSON.parse(readFileSync(dir + "/responses.json", "utf8"))[count];
if (!response) { console.error("unexpected API call"); process.exit(1); }
if (response.pages) for (const page of response.pages) console.log(JSON.stringify(page));
if (response.error) { console.error(response.error); process.exit(1); }
`);
  // Keep the actual jq evaluator: mocking its JSON output would hide broken filters.
  executable(setup.dir, "jq", `#!/usr/bin/env bash\nprintf 'called\\n' >> "$RUNNER_TEMP/jq-calls"\nexec '${realJq}' "$@"\n`);
  executable(setup.dir, "tail", `#!/usr/bin/env bash\nprintf '%s' "$$" > "$RUNNER_TEMP/tail-pid"\nexec '${realTail}' "$@"\n`);
  const result = Bun.spawnSync(["bash", join(scripts, "wait-ci.sh"), "head", ...args], { env: { ...setup.env, ...extraEnv }, timeout: 3000 });
  return { ...setup, result, calls: Number(readFileSync(join(setup.dir, "calls"), "utf8")) };
}

function expectTailReleased(dir: string) {
  const pid = Number(readFileSync(join(dir, "tail-pid"), "utf8"));
  // A killed child can outlive its parent's exit for a few milliseconds, while a leaked one never leaves.
  for (const deadline = performance.now() + 2000; ; Bun.sleepSync(5)) {
    try { process.kill(pid, 0); } catch { return; }
    if (performance.now() > deadline) throw new Error(`tail ${pid} outlived the wait`);
  }
}

afterEach(() => {
  for (const dir of homes.splice(0)) {
    const pidFile = join(dir, "tail-pid");
    if (existsSync(pidFile)) {
      try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGTERM"); } catch (error: any) { if (error.code !== "ESRCH") throw error; }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Stop consumes terminal CI for its head, including events from CI bots", () => {
  const { output } = runHook(frame("check_run", { action: "completed", sender: bot, check_run: check({ conclusion: "failure" }) })
    + frame("workflow_run", { action: "completed", sender: bot, workflow_run: { id: 90, head_sha: "head", name: "build", conclusion: "success" } })
    + frame("status", { sha: "head", state: "error", context: "external", sender: bot }));
  expect(JSON.parse(output).decision).toBe("block");
  for (const name of ["check_run", "workflow_run", "status", "failure", "external"]) expect(output).toContain(name);
});

test("a replay gap requests GitHub reconciliation once without trusting recovered instructions", () => {
  const gap = `event: replay_gap\ndata: ${JSON.stringify({ event: "replay_gap", delivery: "gap:epoch:old:3", writer: false, body: JSON.stringify({ reason: "expired", from: 2, to: 2 }) })}\n\n`;
  const { output, run } = runHook(gap);
  expect(JSON.parse(output).decision).toBe("block");
  expect(output).toContain("replay_gap");
  expect(output).toContain("GitHub");
  expect(output).toContain("write access");
  expect(run().stdout.toString()).toBe("");
  expect(parseFrames(gap)).toBe(gap);
});

test("a stopped subscriber cannot silently leave the review on a stale snapshot", () => {
  const { dir, run } = runHook("");
  writeFileSync(join(dir, "sse.failed"), "The event stream writer failed.");
  const result = run();
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("subscription_failed");
});

test("a cached failure receipt cannot hide a stopped subscription in a later run", () => {
  const { dir, env, run } = runHook("");
  writeFileSync(join(dir, "sse.failed"), "The event stream writer failed.");
  expect(run().stdout.toString()).toContain("subscription_failed");
  expect(run().stdout.toString()).toBe("");
  for (const [GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT] of [["13", "1"], ["13", "2"]]) {
    const retry = Bun.spawnSync(["bash", join(scripts, "review-hook.sh")], { env: { ...env, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT }, stdin: Buffer.from('{"hook_event_name":"Stop"}') });
    expect(retry.exitCode).toBe(0); expect(retry.stdout.toString()).toContain("subscription_failed");
  }
});

test("gap control frames do not break CI waiting or publishing newer heads", () => {
  const gap = `event: replay_gap\ndata: ${JSON.stringify({ event: "replay_gap", delivery: "gap:head", writer: false, body: JSON.stringify({ reason: "expired" }) })}\n\n`;
  const ci = runCI([{ pages: [{ check_runs: [check({ status: "in_progress" })] }] }, { pages: [{ check_runs: [check()] }] }], gap + frame("status", { sha: "head", state: "success" }));
  expect(ci.result.exitCode).toBe(0); expect(ci.calls).toBe(2); expectTailReleased(ci.dir);
  const { dir, env } = fixture();
  writeFileSync(join(dir, "sse.jsonl"), gap + frame("pull_request", { action: "synchronize", number: 7, after: "newer" }));
  const publish = step("Publish check run").run.split("# Pushes made")[0] + '\nprintf "%s" "$PUSHED"';
  const result = Bun.spawnSync(["bash", "-ec", publish], { env });
  expect(result.exitCode).toBe(0); expect(result.stdout.toString()).toBe("newer");
});

test("consumption checkpoints cover the Stop snapshot, never later arrivals", () => {
  const one = frame("issue_comment", { issue: { number: 7 }, comment: { body: "first" } }, "first", true, "seq:epoch:1");
  const two = frame("issue_comment", { issue: { number: 8 }, comment: { body: "other PR" } }, "second", true, "seq:epoch:2");
  const { dir, output } = runHook(one + two);
  expect(output).toContain("first");
  expect(output).not.toContain("other PR");
  writeFileSync(join(dir, "sse.jsonl"), one + two + frame("status", { sha: "head", state: "failure" }, "later", false, "seq:epoch:3"));
  expect(readFileSync(join(dir, "injected-cursor"), "utf8")).toBe("seq:epoch:2\n");
});

test("consumption checkpoints preserve opaque broker cursors", () => {
  const cursor = "next-format/opaque:42";
  const { dir } = runHook(frame("status", { sha: "head", state: "success" }, "status", true, cursor));
  expect(readFileSync(join(dir, "injected-cursor"), "utf8")).toBe(cursor + "\n");
});

test("Stop excludes other heads, nonterminal CI, suites, its App and this workflow run", () => {
  const log = [
    frame("check_run", { action: "completed", check_run: check({ head_sha: "other" }) }, "other"),
    frame("check_run", { action: "created", check_run: check() }, "created"),
    frame("check_run", { action: "completed", check_run: check({ name: "code-review" }) }, "review"),
    frame("check_run", { action: "completed", check_run: check({ id: 11 }) }, "job"),
    frame("check_run", { action: "completed", check_run: check({ id: 10 }) }, "check"),
    frame("check_run", { action: "completed", check_run: check({ details_url: "https://github.com/owner/repo/actions/runs/12/job/99" }) }, "run-check"),
    frame("check_run", { action: "completed", check_run: check(), sender: { login: "reviewer[bot]", type: "Bot" } }, "bot"),
    frame("workflow_run", { action: "completed", workflow_run: { id: 12, head_sha: "head" } }, "run"),
    frame("workflow_run", { action: "in_progress", workflow_run: { id: 90, head_sha: "head" } }, "running"),
    frame("workflow_run", { action: "completed", workflow_run: { id: 90, head_sha: "other" } }, "other-run"),
    frame("status", { sha: "head", state: "pending" }, "pending"),
    frame("status", { sha: "other", state: "success" }, "other-status"),
    frame("status", { sha: "head", state: "success", target_url: "https://github.com/owner/repo/actions/runs/12" }, "run-status"),
    frame("check_suite", { action: "completed", check_suite: { head_sha: "head" } }),
  ].join("");
  const { output, dir } = runHook(log);
  expect(output).toBe("");
  expect(existsSync(join(dir, "injected-deliveries.log")) ? readFileSync(join(dir, "injected-deliveries.log"), "utf8") : "").toBe("");
});

test("all human discussion types require writer=true and a non-Bot sender", () => {
  for (const event of ["issue_comment", "pull_request_review", "pull_request_review_comment", "pull_request_review_thread"]) {
    const body = { action: "resolved", pull_request: { number: 7 }, thread: { resolved: true, comments: [{ path: "file.ts", line: 8 }] } };
    expect(runHook(frame(event, body, "no-write", false)).output).toBe("");
    expect(runHook(frame(event, { ...body, sender: bot }, "bot", true)).output).toBe("");
    expect(runHook(frame(event, body)).output).toContain(event);
    expect(runHook(frame(event, { ...body, pull_request: { number: 8 } })).output).toBe("");
  }
});

test("branch comments match HEAD_SHA, and pushes match HEAD_BRANCH for branches and PRs", () => {
  const comments = frame("commit_comment", { comment: { commit_id: "other", body: "ignore" } }, "old")
    + frame("commit_comment", { comment: { commit_id: "head", body: "keep" } }, "current")
    + frame("commit_comment", { comment: { commit_id: "head", body: "untrusted" } }, "untrusted", false)
    + frame("commit_comment", { sender: bot, comment: { commit_id: "head", body: "automation" } }, "automated");
  const { output } = runHook(comments, { PR_NUMBER: "" });
  expect(output).toContain("keep");
  for (const text of ["ignore", "untrusted", "automation"]) expect(output).not.toContain(text);
  for (const PR_NUMBER of ["", "7"]) {
    const { output } = runHook(frame("push", { ref: "refs/heads/main", after: "wrong" }, "main") + frame("push", { ref: "refs/heads/feature", after: "next" }, "feature"), { PR_NUMBER });
    expect(output).toContain("next");
    expect(output).not.toContain("wrong");
  }
});

test("head changes and draft transitions reach the review, while the events that start one are not replayed", () => {
  const pull = (action: string) => frame("pull_request", { action, number: 7, pull_request: { number: 7, head: { sha: "next" } } });
  for (const action of ["ready_for_review", "synchronize"]) expect(runHook(pull(action)).output).toContain(action);
  expect(runHook(pull("synchronize")).output).toContain("next");
  for (const action of ["opened", "reopened"]) expect(runHook(pull(action)).output).toBe("");
});

test("history plus pending replay is deduplicated within one Stop and across Stops", () => {
  const event = frame("issue_comment", { issue: { number: 7 }, comment: { body: "once-only" } }, "same-delivery");
  const { output, run, dir } = runHook(event + event);
  expect(output.match(/once-only/g)).toHaveLength(1);
  expect(run().stdout.toString()).toBe("");
  expect(readFileSync(join(dir, "injected-deliveries.log"), "utf8")).toBe("same-delivery\n");
});

test("a tool round carries new activity before the verdict and leaves nothing for Stop", () => {
  const setup = fixture();
  executable(setup.dir, "gh", "#!/bin/sh\ncat > /dev/null\n");
  writeFileSync(join(setup.dir, "sse.jsonl"), frame("issue_comment", { action: "created", issue: { number: 7 }, comment: { body: "mid-turn" } }, "mid-turn"));
  const pre = Bun.spawnSync(["bash", join(scripts, "review-hook.sh")], { env: setup.env, stdin: Buffer.from('{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"ls"}}'), timeout: 3000 });
  expect(pre.exitCode).toBe(0);
  expect(pre.stdout.toString()).toBe("");
  const round = Bun.spawnSync(["bash", join(scripts, "review-hook.sh")], { env: setup.env, stdin: Buffer.from('{"hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"ls"}}'), timeout: 3000 });
  expect(round.exitCode).toBe(0);
  const payload = JSON.parse(round.stdout.toString());
  expect(payload.hookSpecificOutput.hookEventName).toBe("PostToolUse");
  expect(payload.hookSpecificOutput.additionalContext).toContain("mid-turn");
  const stop = Bun.spawnSync(["bash", join(scripts, "review-hook.sh")], { env: setup.env, stdin: Buffer.from('{"hook_event_name":"Stop"}'), timeout: 3000 });
  expect(stop.exitCode).toBe(0);
  expect(stop.stdout.toString()).toBe("");
});

test("a subagent tool round leaves shared activity for the main review", () => {
  const setup = fixture();
  writeFileSync(join(setup.dir, "sse.jsonl"), frame("issue_comment", { action: "created", issue: { number: 7 }, comment: { body: "parent-only" } }, "parent-only"));
  const sub = Bun.spawnSync(["bash", join(scripts, "review-hook.sh")], { env: setup.env, stdin: Buffer.from('{"hook_event_name":"PostToolUse","agent_id":"child","tool_name":"Bash","tool_input":{"command":"ls"}}'), timeout: 3000 });
  expect(sub.exitCode).toBe(0);
  expect(sub.stdout.toString()).toBe("");
  expect(existsSync(join(setup.dir, "injected-deliveries.log"))).toBe(false);
  expect(existsSync(join(setup.dir, "injected-cursor"))).toBe(false);
  const stop = Bun.spawnSync(["bash", join(scripts, "review-hook.sh")], { env: setup.env, stdin: Buffer.from('{"hook_event_name":"Stop"}'), timeout: 3000 });
  expect(stop.stdout.toString()).toContain("parent-only");
});

test("parallel tool rounds never lose activity to a shared receipt file", async () => {
  const setup = fixture();
  writeFileSync(join(setup.dir, "sse.jsonl"), frame("issue_comment", { action: "created", issue: { number: 7 }, comment: { body: "concurrent" } }, "concurrent"));
  const rounds = Array.from({ length: 4 }, () => Bun.spawn(["bash", join(scripts, "review-hook.sh")], { env: setup.env, stdin: Buffer.from('{"hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"ls"}}'), stdout: "pipe", stderr: "pipe" }));
  const outputs = await Promise.all(rounds.map(async child => { const output = await new Response(child.stdout).text(); expect(await child.exited).toBe(0); return output; }));
  expect(outputs.some(output => output.includes("concurrent"))).toBe(true);
  expect(readFileSync(join(setup.dir, "injected-deliveries.log"), "utf8")).toContain("concurrent\n");
  const stop = Bun.spawnSync(["bash", join(scripts, "review-hook.sh")], { env: setup.env, stdin: Buffer.from('{"hook_event_name":"Stop"}'), timeout: 3000 });
  expect(stop.stdout.toString()).toBe("");
});

test("a failed context write leaves the event available for the next Stop", async () => {
  const { dir, env } = fixture();
  writeFileSync(join(dir, "sse.jsonl"), frame("issue_comment", { action: "created", issue: { number: 7 }, comment: { body: "pending-event" } }, "pending-event", true, "seq:epoch:9"));
  writeFileSync(join(dir, "injected-cursor"), "seq:epoch:8\n");
  const child = Bun.spawn(["bash", join(scripts, "review-hook.sh")], { env, stdin: Buffer.from('{"hook_event_name":"Stop"}'), stdout: "pipe", stderr: "pipe" });
  await child.stdout.cancel();
  expect(await child.exited).not.toBe(0);
  expect(readFileSync(join(dir, "injected-cursor"), "utf8")).toBe("seq:epoch:8\n");
  const retry = Bun.spawnSync(["bash", join(scripts, "review-hook.sh")], { env, stdin: Buffer.from('{"hook_event_name":"Stop"}') });
  expect(retry.exitCode).toBe(0);
  expect(retry.stdout.toString()).toContain("pending-event");
});

test("CI wait paginates, excludes both owned IDs and only its own App review check", () => {
  const { result, dir, calls } = runCI([{ pages: [
    { check_runs: [check({ id: 10, status: "in_progress" }), check({ id: 11, status: "in_progress" }), check({ id: 12, name: "code-review", app: { slug: "reviewer" }, status: "in_progress" })] },
    { check_runs: [check({ name: "code-review", app: { slug: "other-reviewer" }, conclusion: "failure" }), check()] },
  ] }]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe("code-review: failure\ntest: success\n");
  expect(calls).toBe(1);
  expect(existsSync(join(dir, "jq-calls"))).toBe(true);
  expectTailReleased(dir);
});

test("another run of this workflow is review status, not CI", () => {
  const { result, dir, calls } = runCI([
    { pages: [{ workflow_id: 42 }] },
    { pages: [{ workflow_runs: [{ id: 1, workflow_id: 42, check_suite_id: 7 }] }] },
    { pages: [{ check_runs: [check(), check({ id: 101, status: "queued", check_suite: { id: 7 } })] }] },
  ], "", [".", "pass"], { ACTIONS_TOKEN: "job-token" });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe("test: success\n");
  expect(calls).toBe(3);
});

test("a queued check from another workflow still blocks the wait", () => {
  const { result, dir } = runCI([
    { pages: [{ workflow_id: 42 }] },
    { pages: [{ workflow_runs: [{ id: 1, workflow_id: 42, check_suite_id: 7 }] }] },
    { pages: [{ check_runs: [check(), check({ id: 101, status: "queued", check_suite: { id: 9 } })] }] },
  ], "", [".", "pass"], { ACTIONS_TOKEN: "job-token", WAIT_CI_TIMEOUT: "1" });
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("No CI checks matching");
  expectTailReleased(dir);
});

test("this run's own other jobs are still CI", () => {
  const { result, dir } = runCI([
    { pages: [{ workflow_id: 42 }] },
    { pages: [{ workflow_runs: [{ id: 12, workflow_id: 42, check_suite_id: 7 }, { id: 1, workflow_id: 42, check_suite_id: 8 }] }] },
    { pages: [{ check_runs: [check({ status: "in_progress", check_suite: { id: 7 } }), check({ id: 101, status: "queued", check_suite: { id: 8 } })] }] },
  ], "", [".", "pass"], { ACTIONS_TOKEN: "job-token", WAIT_CI_TIMEOUT: "1" });
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("No CI checks matching");
  expectTailReleased(dir);
});

test("zero matching checks waits for an SSE event instead of succeeding vacuously", () => {
  const { result, calls, dir } = runCI([{ pages: [{ check_runs: [check({ name: "unrelated" })] }] }, { pages: [{ check_runs: [check()] }] }],
    frame("check_run", { action: "completed", check_run: check() }), ["^test$"]);
  expect(result.exitCode).toBe(0);
  expect(calls).toBe(2);
  expect(result.stdout.toString()).toBe("test: success\n");
  expectTailReleased(dir);
});

test("a pending check on a later page waits, and unrelated events do not trigger requests", () => {
  const { result, calls, dir } = runCI([
    { pages: [{ check_runs: [check()] }, { check_runs: [check({ id: 101, status: "in_progress" })] }] },
    { pages: [{ check_runs: [check(), check({ id: 101 })] }] },
  ], frame("check_run", { check_run: check({ head_sha: "other" }) }, "wrong-head")
    + frame("check_suite", { check_suite: { head_sha: "head" } }, "suite")
    + frame("check_run", { action: "completed", check_run: check({ id: 101 }) }, "complete"));
  expect(result.exitCode).toBe(0);
  expect(calls).toBe(2);
  expectTailReleased(dir);
});

test("API errors, including failure after a partial page, fail visibly and release tail", () => {
  for (const pages of [undefined, [{ check_runs: [check()] }]]) {
    const { result, calls, dir } = runCI([{ pages, error: "HTTP 502: later page failed" }]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("HTTP 502");
    expect(result.stderr.toString()).toContain("Could not read CI checks");
    expect(calls).toBe(1);
    expectTailReleased(dir);
  }
});

test("pass mode rejects failed checks while the default waits only for completion", () => {
  for (const conclusion of ["failure", "cancelled", "timed_out", "success", "neutral", "skipped"]) {
    const { result, dir } = runCI([{ pages: [{ check_runs: [check({ conclusion })] }] }], "", [".", "pass"]);
    expect(result.exitCode).toBe(["success", "neutral", "skipped"].includes(conclusion) ? 0 : 1);
    expectTailReleased(dir);
  }
  expect(runCI([{ pages: [{ check_runs: [check({ conclusion: "failure" })] }] }]).result.exitCode).toBe(0);
});

test("an empty check list proceeds when the caller allows it", () => {
  const r = runCI([{ pages: [{ check_runs: [] }] }], "", [".", "pass"], { WAIT_CI_ALLOW_EMPTY: "1" });
  expect(r.result.exitCode).toBe(0);
  expect(r.calls).toBe(1);
});

test("TERM interrupts an event wait and reaps its tail child", async () => {
  const { dir, env } = fixture();
  executable(dir, "gh", "#!/usr/bin/env bash\nprintf '{\"check_runs\":[]}\\n'\n");
  executable(dir, "tail", `#!/usr/bin/env bash\nprintf '%s' "$$" > "$RUNNER_TEMP/tail-pid"\nprintf 'tail-ready\\n' >&2\nexec '${realTail}' "$@"\n`);
  executable(dir, "jq", `#!/usr/bin/env bash\n'${realJq}' "$@"\nstatus=$?\nif [[ "$*" == *'length > 0'* ]]; then printf 'waiting\\n' >&2; fi\nexit "$status"\n`);
  const child = Bun.spawn(["bash", join(scripts, "wait-ci.sh"), "head"], { env, stdout: "pipe", stderr: "pipe", timeout: 3000 });
  try {
    const reader = child.stderr.getReader();
    let stderr = "";
    while (!stderr.includes("tail-ready") || !stderr.includes("waiting")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`wait exited before readiness: ${stderr}`);
      stderr += new TextDecoder().decode(chunk.value);
    }
    reader.releaseLock();
    child.kill("SIGTERM");
    expect(await child.exited).toBe(143);
    expectTailReleased(dir);
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    await child.exited;
  }
});

test("an ended tail fails instead of spinning on EOF", () => {
  const { dir, env } = fixture();
  executable(dir, "gh", "#!/usr/bin/env bash\nprintf '{\"check_runs\":[]}\\n'\n");
  executable(dir, "tail", '#!/usr/bin/env bash\nprintf "%s" "$$" > "$RUNNER_TEMP/tail-pid"\n');
  const result = Bun.spawnSync(["bash", join(scripts, "wait-ci.sh"), "head"], { env, timeout: 3000 });
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("CI event stream closed before checks completed");
  expectTailReleased(dir);
});

test.each(["heartbeat", "silence"])("CI deadline remains bounded during %s", (mode) => {
  const { dir, env } = fixture();
  executable(dir, "gh", '#!/usr/bin/env bash\nprintf \'{"check_runs":[]}\\n\'\n');
  executable(dir, "tail", `#!${process.execPath}\nimport { writeFileSync } from "node:fs";\nwriteFileSync(process.env.RUNNER_TEMP + "/tail-pid", String(process.pid));\nsetInterval(() => { ${mode === "heartbeat" ? 'console.log(": ping")' : ''} }, 50);\n`);
  // Bash's whole-second clock can exhaust a 1s budget before the child even writes its PID near a clock boundary.
  const result = Bun.spawnSync(["bash", join(scripts, "wait-ci.sh"), "head"], { env: { ...env, WAIT_CI_TIMEOUT: "2" }, timeout: 4000 });
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("within 2s");
  expectTailReleased(dir);
});

test("heartbeats do not postpone the fallback CI check after a missed webhook", () => {
  const { dir, env } = fixture();
  executable(dir, "gh", `#!${process.execPath}\nimport { existsSync, writeFileSync } from "node:fs";\nconst marker = process.env.RUNNER_TEMP + "/checked";\nconsole.log(JSON.stringify({ check_runs: existsSync(marker) ? [${JSON.stringify(check())}] : [] }));\nwriteFileSync(marker, "yes");\n`);
  executable(dir, "tail", `#!${process.execPath}\nimport { writeFileSync } from "node:fs";\nwriteFileSync(process.env.RUNNER_TEMP + "/tail-pid", String(process.pid));\nsetInterval(() => console.log(": ping"), 50);\n`);
  const result = Bun.spawnSync(["bash", join(scripts, "wait-ci.sh"), "head"], { env: { ...env, WAIT_CI_TIMEOUT: "2", WAIT_CI_RECHECK: "1" }, timeout: 4000 });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("test: success");
  expectTailReleased(dir);
});

function parseFrames(input: string) {
  const result = Bun.spawnSync(["awk", "-f", join(scripts, "sse-frames.awk")], { stdin: Buffer.from(input) });
  expect(result.exitCode).toBe(0);
  return result.stdout.toString();
}

test("SSE only commits blank-line-terminated frames and discards reconnect fragments", () => {
  const first = frame("status", { sha: "head", state: "success" }, "first");
  const next = frame("status", { sha: "head", state: "failure" }, "next");
  for (const fragment of ["id: next", "id: next\n", "id: next\ndata: {", next.slice(0, -1)]) {
    const committed = parseFrames(first + fragment);
    expect(committed).toBe(first);
    expect([...committed.matchAll(/^id: (.*)$/gm)].at(-1)?.[1]).toBe("first");
    expect(committed + parseFrames(next)).toBe(first + next);
  }
  expect(parseFrames(first.replaceAll("\n", "\r\n"))).toBe(first);
});

test("a failed SSE write does not advance its replay cursor", async () => {
  const { dir, env } = fixture(), cursor = join(dir, "sse.cursor");
  writeFileSync(cursor, "previous\n");
  const child = Bun.spawn(["bash", join(scripts, "sse-frames.sh")], {
    env, stdin: Buffer.from(frame("status", { sha: "head", state: "success" }, "unwritten")), stdout: "pipe", stderr: "pipe",
  });
  await child.stdout.cancel();
  expect(await child.exited).not.toBe(0);
  expect(readFileSync(cursor, "utf8")).toBe("previous\n");
});

test("HTTP framing skips informational headers before accepting an HTTP/2 event stream", () => {
  const { dir, env } = fixture(), response = join(dir, "response");
  const event = frame("status", { sha: "head", state: "success" }, "accepted");
  const headers = "HTTP/1.1 103 Early Hints\r\nLink: </asset>\r\n\r\nHTTP/2 200\r\ncOnTeNt-TyPe: Text/Event-Stream ; charset=utf-8\r\n\r\n";
  const result = Bun.spawnSync(["bash", join(scripts, "sse-frames.sh"), response], { env, stdin: Buffer.from(headers + event) });
  expect(result.exitCode).toBe(0); expect(result.stdout.toString()).toBe(event);
  expect(readFileSync(response, "utf8")).toBe("200 text/event-stream\n");
  expect(readFileSync(join(dir, "sse.cursor"), "utf8")).toBe("accepted\n");
});

test("the subscription survives 360 HTTP failures and stops all its own children", async () => {
  const { dir, env } = fixture();
  executable(dir, "sleep", "#!/usr/bin/env bash\nexit 0\n");
  writeFileSync(join(dir, "sse.cursor"), "previous\n");
  let requests = 0;
  const cursors: (string | null)[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    requests++; cursors.push(request.headers.get("last-event-id"));
    if (requests <= 360) return new Response("UNAVAILABLE BODY MUST NOT BECOME AN EVENT", { status: 503 });
    return new Response(requests === 361 ? frame("status", { sha: "head", state: "success" }, "restored") : new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(": ping\n\n")); } }), { headers: { "content-type": "text/event-stream" } });
  } });
  const child = Bun.spawn(["bash", join(scripts, "subscribe.sh"), "previous"], { env: { ...env, EVENTS_URL: `${server.url}?fixture=1` }, stdout: "pipe", stderr: "pipe" });
  try {
    const deadline = performance.now() + 15_000;
    while (requests < 362 && child.exitCode === null && performance.now() < deadline) await Bun.sleep(10);
    expect(requests).toBeGreaterThanOrEqual(362);
    expect(cursors.slice(0, 361).every(cursor => cursor === "previous")).toBe(true);
    expect(cursors[361]).toBe("restored");
    const log = readFileSync(join(dir, "sse.jsonl"), "utf8");
    expect(log).toContain("connection_failed"); expect(log).toContain("restored"); expect(log).not.toContain("UNAVAILABLE BODY");
    expect(readFileSync(join(dir, "sse.err"), "utf8")).toContain("503");
    const rows = Bun.spawnSync(["ps", "-axo", "pid=,ppid="]).stdout.toString().trim().split("\n").map(line => line.trim().split(/\s+/).map(Number));
    const owned = new Set([child.pid]);
    for (let count = 0; count !== owned.size;) { count = owned.size; for (const [pid, parent] of rows) if (owned.has(parent!)) owned.add(pid!); }
    expect(owned.size).toBeGreaterThanOrEqual(4); // subscriber, curl, parser wrapper, awk
    const pipes = readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name.startsWith("sse.")).map(entry => entry.name);
    child.kill("SIGTERM"); expect(await child.exited).toBe(143);
    for (const pid of owned) {
      let alive = true;
      for (const end = performance.now() + 2000; alive && performance.now() < end; await Bun.sleep(5)) {
        try { process.kill(pid, 0); } catch (error: any) { if (error.code !== "ESRCH") throw error; alive = false; }
      }
      expect(alive).toBe(false);
    }
    for (const pipe of pipes) expect(existsSync(join(dir, pipe))).toBe(false);
    expect(existsSync(join(dir, "sse.failed"))).toBe(false);
  } finally { if (child.exitCode === null) child.kill("SIGTERM"); await child.exited; server.stop(true); }
}, 20_000);

test("a failed stream writer records a visible terminal failure", () => {
  const { dir, env } = fixture();
  executable(dir, "curl", "#!/usr/bin/env bash\nexit 0\n");
  executable(dir, "awk", "#!/usr/bin/env bash\nexit 1\n");
  const child = Bun.spawnSync(["bash", join(scripts, "subscribe.sh")], { env: { ...env, EVENTS_URL: "https://example.test/?fixture=1" }, timeout: 3000 });
  expect(child.exitCode).toBe(1);
  expect(readFileSync(join(dir, "sse.failed"), "utf8")).toContain("status 1");
});

test("a cached outage receipt cannot hide a new run failing at the same cursor", () => {
  const { dir, env } = fixture();
  executable(dir, "curl", "#!/usr/bin/env bash\nexit 22\n");
  executable(dir, "sleep", '#!/usr/bin/env bash\nkill -TERM "$PPID"\n');
  for (const [GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT] of [["12", "1"], ["13", "1"], ["13", "2"]]) {
    writeFileSync(join(dir, "sse.jsonl"), "");
    const current = { ...env, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, EVENTS_URL: "https://example.test/?fixture=1" };
    const subscription = Bun.spawnSync(["bash", join(scripts, "subscribe.sh"), "seq:epoch:4"], { env: current, timeout: 3000 });
    expect(subscription.exitCode).toBe(143);
    const run = () => Bun.spawnSync(["bash", join(scripts, "review-hook.sh")], { env: current, stdin: Buffer.from('{"hook_event_name":"Stop"}') });
    const result = run(); expect(result.exitCode).toBe(0); expect(result.stdout.toString()).toContain("connection_failed");
    expect(run().stdout.toString()).toBe("");
  }
});

test.each(["html", "wrong type with SSE bytes", "no headers", "empty SSE", "SSE rotation"])("the subscriber distinguishes %s from a failed response", async mode => {
  const { dir, env } = fixture();
  writeFileSync(join(dir, "sse.cursor"), "previous\n");
  executable(dir, "curl", `#!/usr/bin/env bash\nexec '${realCurl}' "$@" --max-time 0.1\n`);
  executable(dir, "sleep", '#!/usr/bin/env bash\nprintf "%s\\n" "$1" >> "$RUNNER_TEMP/delays"\n[ "$(wc -l < "$RUNNER_TEMP/delays")" -lt 2 ] || kill -TERM "$PPID"\n');
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    if (mode === "no headers") return new Promise<Response>(() => {});
    if (mode === "html") return new Response("<html>Service unavailable</html>", { headers: { "content-type": "text/html" } });
    if (mode === "wrong type with SSE bytes") return new Response(frame("status", { sha: "head", state: "success" }, "invalid-cursor"), { headers: { "content-type": "text/plain" } });
    const body = mode === "empty SSE" ? "" : new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(": ping\n\n")); } });
    return new Response(body, { headers: { "content-type": "Text/Event-Stream; charset=utf-8" } });
  } });
  const child = Bun.spawn(["bash", join(scripts, "subscribe.sh")], { env: { ...env, EVENTS_URL: `${server.url}?fixture=1` }, stdout: "pipe", stderr: "pipe", timeout: 3000 });
  try {
    expect(await child.exited).toBe(143);
    const failure = mode === "html" || mode === "wrong type with SSE bytes" || mode === "no headers";
    expect(readFileSync(join(dir, "delays"), "utf8").trim().split("\n").map(Number)).toEqual(failure ? [1, 2] : [1, 1]);
    const log = readFileSync(join(dir, "sse.jsonl"), "utf8");
    expect(log.includes("connection_failed")).toBe(failure);
    expect(log).not.toContain("invalid-cursor"); expect(log).not.toContain("<html>"); expect(log).not.toContain("content-type:");
    expect(readFileSync(join(dir, "sse.cursor"), "utf8")).toBe("previous\n");
  } finally { if (child.exitCode === null) child.kill("SIGTERM"); await child.exited; server.stop(true); }
});

test.each([
  ["outage and recovery", [22, 22, 22, 22, 22, 22, 22, 22, 28, 7, 0, 22, 22], [[1, 1], [2, 2], [3, 4], [6, 8], [12, 16], [23, 30], [23, 30], [23, 30], [1, 1], [1, 1], [1, 1], [1, 1], [2, 2]]],
  ["healthy rotations", [28, 28, 0], [[1, 1], [1, 1], [1, 1]]],
] as const)("subscription retry delays stay bounded through %s", (_, statuses, bounds) => {
  const { dir, env } = fixture();
  writeFileSync(join(dir, "statuses"), statuses.join("\n") + "\n");
  executable(dir, "curl", '#!/usr/bin/env bash\nprintf "HTTP/1.1 200 OK\\r\\nContent-Type: text/event-stream\\r\\n\\r\\n"\ncount=$(wc -l < "$RUNNER_TEMP/delays" 2>/dev/null || echo 0)\nexit "$(sed -n "$((count + 1))p" "$RUNNER_TEMP/statuses")"\n');
  executable(dir, "sleep", `#!/usr/bin/env bash\nprintf '%s\\n' "$1" >> "$RUNNER_TEMP/delays"\n[ "$(wc -l < "$RUNNER_TEMP/delays")" -lt ${statuses.length} ] || kill -TERM "$PPID"\n`);
  const child = Bun.spawnSync(["bash", join(scripts, "subscribe.sh")], { env: { ...env, EVENTS_URL: "https://example.test/?fixture=1" }, timeout: 3000 });
  expect(child.exitCode).toBe(143);
  const delays = readFileSync(join(dir, "delays"), "utf8").trim().split("\n").map(Number);
  expect(delays).toHaveLength(bounds.length);
  for (const [i, [min, max]] of bounds.entries()) { expect(delays[i]!).toBeGreaterThanOrEqual(min); expect(delays[i]!).toBeLessThanOrEqual(max); }
  const { output, run } = runHook(readFileSync(join(dir, "sse.jsonl"), "utf8"));
  expect((output.match(/connection_failed/g) || []).length).toBe(statuses.some(status => status !== 0 && status !== 28) ? 1 : 0);
  expect(run().stdout.toString()).toBe("");
});

test("branch subscriptions do not require a PR number", () => {
  const { dir, env } = fixture(), { PR_NUMBER: _, ...branchEnv } = env;
  executable(dir, "curl", '#!/usr/bin/env bash\nprintf "HTTP/1.1 200 OK\\r\\nContent-Type: text/event-stream\\r\\n\\r\\n"\nprintf "%s\\n" "$@" > "$RUNNER_TEMP/curl-args"\nexit 28\n');
  executable(dir, "sleep", '#!/usr/bin/env bash\nkill -TERM "$PPID"\n');
  const child = Bun.spawnSync(["bash", join(scripts, "subscribe.sh")], { env: { ...branchEnv, EVENTS_URL: "https://example.test/?fixture=1" }, timeout: 3000 });
  expect(child.exitCode).toBe(143);
  expect(readFileSync(join(dir, "curl-args"), "utf8")).toContain("&pr=&sha=head&run=12");
});

test("TERM interrupts a long retry delay after the failure becomes visible", async () => {
  const { dir, env } = fixture();
  executable(dir, "curl", "#!/usr/bin/env bash\nexit 22\n");
  executable(dir, "sleep", `#!/usr/bin/env bash\n[ "$1" -ge 20 ] || exit 0\nprintf '%s' "$$" > "$RUNNER_TEMP/sleep-pid"\nexec '${realSleep}' "$1"\n`);
  const child = Bun.spawn(["bash", join(scripts, "subscribe.sh")], { env: { ...env, EVENTS_URL: "https://example.test/?fixture=1" }, stdout: "pipe", stderr: "pipe" });
  try {
    const marker = join(dir, "sleep-pid");
    for (const deadline = performance.now() + 3000; !existsSync(marker) && performance.now() < deadline;) await Bun.sleep(5);
    expect(existsSync(marker)).toBe(true);
    expect(readFileSync(join(dir, "sse.jsonl"), "utf8")).toContain("connection_failed");
    const sleeper = Number(readFileSync(marker, "utf8"));
    child.kill("SIGTERM");
    expect(await Promise.race([child.exited, Bun.sleep(2000).then(() => "timed out")])).toBe(143);
    expect(() => process.kill(sleeper, 0)).toThrow();
    expect(existsSync(join(dir, "sse.failed"))).toBe(false);
  } finally { if (child.exitCode === null) child.kill("SIGTERM"); await child.exited; }
});

test.each([
  ["empty response", "", "dispatch", "", "dispatch"],
  ["heartbeat", ": ping\n\n", "dispatch", "", "dispatch"],
  ["truncated id", "id: lost", "dispatch", "", "dispatch"],
  ["truncated frame", "id: lost\ndata: {}\n", "dispatch", "", "dispatch"],
  ["no saved cursor", "", "", "", ""],
  ["only a gap receipt", "", "gap:old:cursor", "", ""],
  ["a consumed sequence", "", "dispatch", "seq:epoch:5", "seq:epoch:5"],
])("the real subscription preserves its replay cursor after %s", (_, initialResponse, savedCursor, checkpoint, expectedCursor) => {
  const { dir, env } = fixture();
  const first = frame("status", { sha: "head", state: "success" }, "first");
  const second = frame("status", { sha: "head", state: "failure" }, "second");
  writeFileSync(join(dir, "response-0"), initialResponse!);
  writeFileSync(join(dir, "response-1"), first + second.slice(0, -1));
  writeFileSync(join(dir, "response-2"), second);
  writeFileSync(join(dir, "response-3"), "");
  executable(dir, "curl", `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const dir = process.env.RUNNER_TEMP;
const log = dir + "/curl-calls";
const count = existsSync(log) ? readFileSync(log, "utf8").trim().split("\\n").length : 0;
appendFileSync(log, JSON.stringify(process.argv.slice(2)) + "\\n");
process.stdout.write("HTTP/1.1 200 OK\\r\\nContent-Type: text/event-stream\\r\\n\\r\\n");
process.stdout.write(readFileSync(dir + "/response-" + count));
process.exit(28);
`);
  executable(dir, "sleep", '#!/usr/bin/env bash\n[ "$(wc -l < "$RUNNER_TEMP/curl-calls")" -lt 4 ] || kill -TERM "$PPID"\n');
  const subscription = step("Subscribe PR updates via SSE").run;
  mkdirSync(join(dir, "sessions"), { recursive: true });
  if (savedCursor) writeFileSync(join(dir, "sessions/.github-deliveries.json"), JSON.stringify([savedCursor]));
  if (checkpoint) writeFileSync(join(dir, "sessions/.github-cursor"), checkpoint);
  writeFileSync(join(dir, "event.json"), JSON.stringify({ action: "created", sender: { login: "collaborator", type: "User" } }));
  const result = Bun.spawnSync(["bash", "-c", subscription + '\nwait "$!" || [ "$?" -eq 143 ]'], { env: { ...env, EVENTS_URL: "https://example.test/events?token=fixture", GITHUB_ENV: join(dir, "github-env"), GITHUB_EVENT_NAME: "issue_comment", GITHUB_EVENT_PATH: join(dir, "event.json"), ACTIVITY_ID: "seed", ACTIVITY_WRITER: "true" }, timeout: 3000 });
  expect(result.exitCode).toBe(0);
  const log = readFileSync(join(dir, "sse.jsonl"), "utf8");
  expect(log.startsWith("id: seed\nevent: issue_comment\ndata: {")).toBe(true);
  expect(log.endsWith(first + second)).toBe(true);
  const calls = readFileSync(join(dir, "curl-calls"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  for (const [i, delivery] of [expectedCursor, expectedCursor, "first", "second"].entries()) {
    if (delivery) expect(calls[i]).toContain(`Last-Event-ID: ${delivery}`);
    else expect(calls[i].some((arg: string) => arg.startsWith("Last-Event-ID:"))).toBe(false);
    expect(calls[i]).toContain("https://example.test/events?token=fixture&pr=7&sha=head&run=12");
  }
});

test("the trigger webhook is seeded in the same shape the broker relays", () => {
  const { dir, env } = fixture();
  mkdirSync(join(dir, "sessions"), { recursive: true });
  writeFileSync(join(dir, "event.json"), JSON.stringify({ action: "created", sender: human, issue: { number: 7, pull_request: {} }, comment: { id: 1, body: "hi" } }));
  const body = Bun.spawnSync(["jq", "-c", ".", join(dir, "event.json")]).stdout.toString().trim();
  const delivery = Bun.spawnSync(["bash", "-c", 'printf %s "$0" | sha256sum | cut -c1-40', body]).stdout.toString().trim();
  executable(dir, "curl", '#!/usr/bin/env bash\nprintf "HTTP/1.1 200 OK\\r\\nContent-Type: text/event-stream\\r\\n\\r\\n"\nexit 28\n');
  executable(dir, "sleep", '#!/usr/bin/env bash\nkill -TERM "$PPID"\n');
  const subscription = step("Subscribe PR updates via SSE").run;
  expect(subscription).toContain('bash "$GITHUB_ACTION_PATH/scripts/subscribe.sh"');
  const result = Bun.spawnSync(["bash", "-c", subscription + '\nwait "$!" || [ "$?" -eq 143 ]'], { env: { ...env, EVENTS_URL: "https://example.test/events?token=fixture", GITHUB_ENV: join(dir, "github-env"), GITHUB_EVENT_NAME: "issue_comment", GITHUB_EVENT_PATH: join(dir, "event.json"), ACTIVITY_ID: delivery, ACTIVITY_WRITER: "true" }, timeout: 3000 });
  expect(result.exitCode).toBe(0);
  const [id, event, data] = readFileSync(join(dir, "sse.jsonl"), "utf8").split("\n");
  expect(id).toBe(`id: ${delivery}`);
  expect(event).toBe("event: issue_comment");
  const parsed = JSON.parse(data.slice(6));
  expect(parsed.delivery).toBe(delivery);
  expect(parsed.event).toBe("issue_comment");
  expect(JSON.parse(parsed.body)).toEqual(JSON.parse(readFileSync(join(dir, "event.json"), "utf8")));
  expect(parsed.writer).toBe(true);
  const review = step("Run codex review");
  expect(review.env.JOB_CHECK_RUN_ID).toBe("${{ job.check_run_id }}");
  expect(review.env.ACTIVITY).toBeUndefined();
});

const step = (name: string) => (Bun.YAML.parse(readFileSync(join(root, "action.yml"), "utf8")) as any).runs.steps.find((s: any) => s.name === name);

test("review instructions reach the prompt as one shell string", () => {
  const { env } = fixture();
  const commands = `. "${join(root, "scripts/instructions.sh")}"\nINSTRUCTIONS="$REVIEW_INSTRUCTIONS"`;
  const result = Bun.spawnSync(["bash", "-eo", "pipefail", "-c", commands + '\nprintf "%s" "$INSTRUCTIONS"'], { env });
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe("");
  expect(result.stdout.toString()).toContain('fold in any older "Worth checking" comment');
  expect(result.stdout.toString()).toContain(`Comments authored by ${env.BOT_LOGIN} are yours`);
});

test("an issue wakes the agent without a verdict schema", () => {
  const { dir, env } = fixture(), run = step("Run codex review").run;
  writeFileSync(join(dir, "issue.json"), JSON.stringify({ action: "labeled", sender: human, issue: { number: 7, html_url: "https://github.com/owner/repo/issues/7" } }));
  const block = run.slice(run.indexOf('if [ "$AGENT" = true ]; then'), run.indexOf("fresh() {")).replaceAll("${{ inputs.service-tier }}", "default");
  const result = Bun.spawnSync(["bash", "-eo", "pipefail", "-c", block + '\nprintf "%s\\n--schema:%s" "$OPEN" "${#SCHEMA[@]}"'], {
    env: { ...env, AGENT: "true", ISSUE_NUMBER: "7", BASE: "main", HEAD_SHA: "abc123", RUNTIME_INFO: "Bun 1.3", GITHUB_EVENT_NAME: "issues", GITHUB_EVENT_PATH: join(dir, "issue.json") },
  });
  expect(result.exitCode).toBe(0);
  const out = result.stdout.toString();
  expect(out).toContain("New GitHub activity on issue #7:");
  expect(out).toContain('"event":"issues"');
  expect(out).toContain("gh issue view 7 --comments");
  expect(out).toContain("never invent work");
  expect(out).not.toContain("JSON review");
  expect(out.endsWith("--schema:0")).toBe(true);
});

test("issue runs propagate Codex failures without requiring a verdict", () => {
  const { dir, env } = fixture();
  mkdirSync(join(dir, "sessions"));
  writeFileSync(join(dir, "issue.json"), JSON.stringify({ action: "labeled", sender: human, issue: { number: 7 } }));
  executable(dir, "codex", '#!/usr/bin/env bash\nprintf \'{"type":"thread.started","thread_id":"thread"}\\n\'\nexit "$CODEX_EXIT"\n');
  executable(dir, "gh", '#!/usr/bin/env bash\necho "Unexpected GitHub call" >&2\nexit 1\n');
  // The log follower is unrelated to the process status and would keep the test's output pipe open.
  executable(dir, "tail", "#!/usr/bin/env bash\nexit 0\n");
  const commands = step("Run codex review").run.replaceAll("${{ inputs.service-tier }}", "default").replace(/\$\{\{[^}]*\}\}/g, "");
  for (const code of ["0", "1"]) {
    const result = Bun.spawnSync(["bash", "-eo", "pipefail", "-c", commands], {
      env: { ...env, AGENT: "true", PR_NUMBER: "", CHECK_ID: "", ISSUE_NUMBER: "7", BASE: "main", FORK_KEY: "", CODEX_BIN: join(dir, "codex"), CODEX_RUNTIME: "", CODEX_EXIT: code,
        GITHUB_EVENT_NAME: "issues", GITHUB_EVENT_PATH: join(dir, "issue.json") }, timeout: 3000,
    });
    expect(result.exitCode).toBe(Number(code));
    expect(existsSync(join(dir, "review.json"))).toBe(false);
  }
});

test("forking a review copies its conversation but not another PRs consumption position", () => {
  const { dir, env } = fixture(), source = join(dir, "code-review-homes/owner/repo/source"), target = join(dir, "target");
  mkdirSync(join(source, "sessions"), { recursive: true }); mkdirSync(target);
  for (const name of [".github-cursor", ".github-deliveries.json", ".github-published-head", "conversation.jsonl"]) writeFileSync(join(source, "sessions", name), "source");
  writeFileSync(join(source, "last-thread-id"), "thread");
  const commands = step("Run codex review").run.match(/fork=\$\{\{ runner.temp \}\}[\s\S]*?(?=\s+\$CODEX_RUNTIME)/)[0].replaceAll("${{ runner.temp }}", dir).replaceAll("${{ github.repository }}", "owner/repo");
  const result = Bun.spawnSync(["bash", "-ec", commands], { env: { ...env, CODEX_HOME: target, FORK_KEY: "source" } });
  expect(result.exitCode).toBe(0);
  expect(readFileSync(join(target, "sessions/conversation.jsonl"), "utf8")).toBe("source");
  expect(existsSync(join(target, "sessions/.github-cursor"))).toBe(false);
  expect(existsSync(join(target, "sessions/.github-deliveries.json"))).toBe(false);
  expect(existsSync(join(target, "sessions/.github-published-head"))).toBe(false);
});

test("a turn that fails after the verdict keeps the verdict it produced", () => {
  const { dir, env } = fixture();
  const verdict = { summary: "no must-fix issues", commits: [{ sha: "head", conclusion: "success" }] };
  writeFileSync(join(dir, "codex.jsonl"), [
    { type: "item.completed", item: { type: "agent_message", text: "I will look at the diff." } },
    { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(verdict) } },
    { type: "error", message: "Selected model is at capacity. Please try a different model." },
    { type: "turn.failed", error: { message: "Selected model is at capacity. Please try a different model." } },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n");
  const commands = step("Run codex review").run.match(/\[ "\$ran" = 1 \] \|\| jq[\s\S]*?review\.json"/)![0];
  const result = Bun.spawnSync(["bash", "-ec", commands], { env });
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(readFileSync(join(dir, "review.json"), "utf8"))).toEqual(verdict);
});

test("a session saved under another provider starts a fresh thread", () => {
  const { dir, env } = fixture();
  const block = step("Run codex review").run.match(/\nif grep -Eq[\s\S]*?\nfi\n/)![0];
  const run = () => Bun.spawnSync(["bash", "-ec", `ran=0\nfresh() { echo fresh-ran; }\nlog() { cat; }\n${block}\necho "ran=$ran"`], { env });
  for (const line of [
    'Error: thread/resume: thread/resume failed: This chat uses openai, but your current provider is review. (code -32600), data: {"type":"modelProviderMismatch","modelProvider":"openai"}',
    JSON.stringify({ type: "error", message: "item type is not supported: unsupported_persisted_item_context" }),
  ]) {
    writeFileSync(join(dir, "codex.jsonl"), line + "\n");
    writeFileSync(join(dir, "last-thread-id"), "thread");
    const result = run();
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("fresh-ran");
    expect(result.stdout.toString()).toContain("ran=1");
    expect(existsSync(join(dir, "last-thread-id"))).toBe(false);
  }
  // The reviewer reading action.yml puts these words in its own output; that is not a failed resume.
  writeFileSync(join(dir, "codex.jsonl"), JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "if grep -Eq 'unsupported_persisted_item_context|modelProviderMismatch' file; then" } }) + "\n");
  writeFileSync(join(dir, "last-thread-id"), "thread");
  const result = run();
  expect(result.stdout.toString()).not.toContain("fresh-ran");
  expect(result.stdout.toString()).toContain("ran=0");
  expect(readFileSync(join(dir, "last-thread-id"), "utf8")).toBe("thread");
});

test("MCP calls fold input and result into one block", () => {
  const log = (item: object) => {
    const result = Bun.spawnSync(["jq", "-Rr", "--arg", "stop", "s", "-f", join(root, "scripts/codex-log.jq")], { stdin: Buffer.from(JSON.stringify({ type: "item.completed", item }) + "\n") });
    expect(result.exitCode).toBe(0);
    return result.stdout.toString();
  };
  const call = { type: "mcp_tool_call", server: "github", tool: "fetch_runs", arguments: { commit_sha: "39a2ec3", per_page: 2 }, result: { content: [{ type: "text", text: '[{"id":1}]' }] }, error: null, status: "completed" };
  // The call and its input name the block; a JSON result is highlighted like jq prints it.
  expect(log(call)).toBe(`::group::github.fetch_runs {\u001b[36m"commit_sha"\u001b[0m:\u001b[32m"39a2ec3"\u001b[0m,\u001b[36m"per_page"\u001b[0m:\u001b[33m2\u001b[0m}\n[{\u001b[36m"id"\u001b[0m:\u001b[33m1\u001b[0m}]\n::endgroup::\n\n`);
  // Long input keeps a full, highlighted copy inside the block, while the title highlight stops at the cut.
  const long = log({ ...call, arguments: { q: "x".repeat(200) } });
  expect(long).toContain(`{\u001b[36m"q"\u001b[0m:\u001b[32m"${"x".repeat(154)}\u001b[0m\u001b[90m…\u001b[0m`);
  expect(long).toContain(`{\u001b[36m"q"\u001b[0m:\u001b[32m"${"x".repeat(200)}"\u001b[0m}`);
  // A cut inside an escape still leaves the whole string green, including text that looks like other JSON tokens.
  for (const suffix of ["\\tail", '"tail', "\ntail"]) {
    const q = "true false null 123".padEnd(153, "x") + suffix;
    expect(log({ ...call, arguments: { q } })).toContain(`{\u001b[36m"q"\u001b[0m:\u001b[32m${JSON.stringify(q).slice(0, 155)}\u001b[0m\u001b[90m…\u001b[0m`);
  }
  // A result that is not JSON stays grey, since it is tool text rather than a record.
  expect(log({ ...call, result: { content: [{ type: "text", text: "plain result" }] } })).toContain("\u001b[90mplain result\u001b[0m");
  // A false JSON value is still a parsed result.
  expect(log({ ...call, result: { content: [{ type: "text", text: "false" }] } })).toContain("\u001b[35mfalse\u001b[0m");
  // A failed call reports its error in red instead of a result.
  expect(log({ ...call, result: null, error: { message: "boom" }, status: "failed" })).toContain("\u001b[31mboom\u001b[0m");
  // The call is shown once, when it finishes, like commands.
  const started = Bun.spawnSync(["jq", "-Rr", "--arg", "stop", "s", "-f", join(root, "scripts/codex-log.jq")], { stdin: Buffer.from(JSON.stringify({ type: "item.started", item: { ...call, status: "in_progress" } }) + "\n") });
  expect(started.exitCode).toBe(0);
  expect(started.stdout.toString()).toBe("");
});

test("file edits and searches fold into titled blocks", () => {
  const log = (item: object, event = "item.completed") => {
    const result = Bun.spawnSync(["jq", "-Rr", "--arg", "stop", "s", "-f", join(root, "scripts/codex-log.jq")], { stdin: Buffer.from(JSON.stringify({ type: event, item }) + "\n") });
    expect(result.exitCode).toBe(0);
    return result.stdout.toString();
  };
  const changes = [{ path: "a.ts", kind: "update" }, { path: "b.ts", kind: "add" }];
  expect(log({ type: "file_change", changes, status: "completed" })).toBe(`::group::edit update a.ts, add b.ts\n\u001b[90mupdate a.ts\u001b[0m\n\u001b[90madd b.ts\u001b[0m\n::endgroup::\n\n`);
  expect(log({ type: "file_change", changes, status: "failed" })).toContain(`::group::\u001b[31medit update a.ts, add b.ts\u001b[0m`);
  expect(log({ type: "file_change", changes: [...changes, ...changes, { path: "c.ts", kind: "delete" }], status: "completed" })).toContain("::group::edit 5 files");
  const search = { type: "web_search", query: "concurrency queue", action: { type: "search" }, results: [{ title: "Docs", url: "https://x" }] };
  expect(log(search)).toContain(`::group::search concurrency queue\n[{\u001b[36m"title"\u001b[0m:\u001b[32m"Docs"\u001b[0m`);
  expect(log({ ...search, query: "", action: { type: "open_page", url: "https://docs" } })).toContain("::group::open https://docs");
  // The start event has nothing to fold and must not print a bare type name.
  expect(log({ type: "web_search", query: "x" }, "item.started")).toBe("");
});

test("folded item data cannot run workflow commands", () => {
  for (const payload of ["CI ##[error]forged", "CI #\r#[error]forged", "first\n::error::forged", "first\n:\r:error::forged"]) {
    for (const item of [
      { type: "file_change", changes: [{ path: payload, kind: "update" }], status: "completed" },
      { type: "web_search", query: payload, action: { type: "search" } },
      { type: "web_search", query: "", action: { type: "open_page", url: payload } },
      { type: "web_search", query: "", action: { type: "find_in_page", pattern: payload, url: "https://docs" } },
      { type: "web_search", query: "docs", action: { type: "search" }, results: [{ title: payload }] },
      { type: "todo_list", items: [{ text: payload, completed: false }] },
      { type: "collab_tool_call", tool: "spawn_agent", prompt: payload },
    ]) {
      const result = Bun.spawnSync(["jq", "--unbuffered", "-rR", "--arg", "stop", "s", "-f", join(root, "scripts/codex-log.jq")], { stdin: Buffer.from(JSON.stringify({ type: "item.completed", item }) + "\n") });
      expect(result.exitCode).toBe(0);
      const commands: string[] = [];
      let stopped = false;
      for (const line of result.stdout.toString().split("\n")) {
        const command = line.replace(/^[\s\u0085]+/, "").match(/^::([^ :]+).*?::/)?.[1]
          ?? line.match(/##\[([^ \]]+)[^\]]*\]/)?.[1];
        if (stopped) {
          if (command === "s") stopped = false;
        } else if (command === "stop-commands") stopped = true;
        else if (command) commands.push(command);
      }
      expect(commands).toEqual(["group", "endgroup"]);
      expect(stopped).toBe(false);
    }
  }
});

test("MCP output cannot run workflow commands", () => {
  for (const payload of ["CI ##[error]forged", "CI #\r#[error]forged", "first\n::error::forged"]) {
    for (const fields of [
      { result: { content: [{ type: "text", text: payload }] } },
      { result: { structured_content: { message: payload } } },
      { error: { message: payload } },
    ]) {
      const item = { type: "mcp_tool_call", server: "github", tool: "fetch_runs", arguments: { q: payload.repeat(20) }, ...fields };
      const result = Bun.spawnSync(["jq", "--unbuffered", "-rR", "--arg", "stop", "s", "-f", join(root, "scripts/codex-log.jq")], { stdin: Buffer.from(JSON.stringify({ type: "item.completed", item }) + "\n") });
      expect(result.exitCode).toBe(0);
      // Match the runner's command parsing: modern commands start after whitespace;
      // legacy commands can appear anywhere, even after ANSI colour escapes.
      const commands: string[] = [];
      let stopped = false;
      for (const line of result.stdout.toString().split("\n")) {
        const command = line.replace(/^[\s\u0085]+/, "").match(/^::([^ :]+).*?::/)?.[1]
          ?? line.match(/##\[([^ \]]+)[^\]]*\]/)?.[1];
        if (stopped) {
          if (command === "s") stopped = false;
        } else if (command === "stop-commands") stopped = true;
        else if (command) commands.push(command);
      }
      expect(commands).toEqual(["group", "endgroup"]);
      expect(stopped).toBe(false);
    }
  }
});

test("the eyes reaction marks the message that triggered the review", () => {
  const { dir, env } = fixture();
  executable(dir, "gh", `#!${process.execPath}
import { appendFileSync } from "node:fs";
appendFileSync(process.env.RUNNER_TEMP + "/gh-args", process.argv.slice(2).join(" ") + "\\n");
console.log("9");
`);
  const commands = step("Mark PR as reviewing").run.replaceAll("${{ github.repository }}", "owner/repo").replace(/\$\{\{[^}]*\}\}/g, "");
  const run = (event: object, name: string) => {
    writeFileSync(join(dir, "event.json"), JSON.stringify(event));
    writeFileSync(join(dir, "github-env"), "");
    writeFileSync(join(dir, "gh-args"), "");
    const result = Bun.spawnSync(["bash", "-ec", commands], { env: { ...env, GITHUB_EVENT_NAME: name, GITHUB_EVENT_PATH: join(dir, "event.json"), GITHUB_ENV: join(dir, "github-env"), PR_NUMBER: "7" } });
    expect(result.exitCode).toBe(0);
    return { args: readFileSync(join(dir, "gh-args"), "utf8"), env: readFileSync(join(dir, "github-env"), "utf8") };
  };
  const comment = run({ action: "created", comment: { id: 77 } }, "issue_comment");
  expect(comment.args).toContain("repos/owner/repo/issues/comments/77/reactions");
  expect(comment.env).toContain("EYES_REACTION_PATH=issues/comments/77/reactions/9");
  expect(run({ action: "created", comment: { id: 77 } }, "pull_request_review_comment").args).toContain("pulls/comments/77/reactions");
  // A deleted comment has nothing to mark, and a review has no reactions endpoint of its own.
  expect(run({ action: "deleted", comment: { id: 77 } }, "issue_comment").args).toContain("repos/owner/repo/issues/7/reactions");
  expect(run({ action: "submitted", review: { id: 5 } }, "pull_request_review").args).toContain("repos/owner/repo/issues/7/reactions");
});

test("a comment deleted before the reaction is posted falls back to the PR body", () => {
  const { dir, env } = fixture();
  executable(dir, "gh", '#!/usr/bin/env bash\ncase "$2" in */comments/*) echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;; esac\necho 9\n');
  executable(dir, "sleep", "#!/usr/bin/env bash\nexit 0\n");
  writeFileSync(join(dir, "event.json"), JSON.stringify({ action: "created", comment: { id: 77 } }));
  const commands = step("Mark PR as reviewing").run.replaceAll("${{ github.repository }}", "owner/repo");
  for (const name of ["issue_comment", "pull_request_review_comment"]) {
    writeFileSync(join(dir, "github-env"), "");
    const result = Bun.spawnSync(["bash", "-eo", "pipefail", "-c", commands], { env: { ...env, GITHUB_EVENT_NAME: name, GITHUB_EVENT_PATH: join(dir, "event.json"), GITHUB_ENV: join(dir, "github-env") } });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(dir, "github-env"), "utf8")).toContain("EYES_REACTION_PATH=issues/7/reactions/9");
  }
});

test("an unfinished check is reused only when no live review owns it", () => {
  const { dir, env } = fixture();
  executable(dir, "gh", `#!${process.execPath}
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2).join(" ");
appendFileSync(process.env.RUNNER_TEMP + "/gh-args", args + "\\n");
if (process.argv[3]?.includes("/actions/runs/") && process.env.GH_TOKEN !== "job-token") { console.error("Actions lookup requires the job token"); process.exit(1); }
if (args.includes("/actions/runs/222")) console.log("in_progress");
else if (args.includes("/actions/runs/111")) console.log("completed");
else if (args.includes("/actions/runs/333")) { console.error("Owner unavailable"); process.exit(1); }
else if (args.includes("/actions/runs/444")) console.log("queued");
else if (args.includes("check-runs?check_name=code-review")) {
  const first = JSON.parse(process.env.CHECKS).find((run: any) => run.status !== "completed");
  if (first) console.log([first.id, first.external_id ?? "", (first.details_url || "").match(/\\/actions\\/runs\\/(\\d+)/)?.[1] ?? "", (first.details_url || "").match(/[?&]attempt=(\\d+)/)?.[1] ?? ""].join(" "));
} else if (args.includes("-X PATCH")) console.log("{}");
else console.log("303");
`);
  executable(dir, "sleep", "#!/usr/bin/env bash\nexit 0\n");
  const commands = step("Open check run").run.replaceAll("${{ github.repository }}", "owner/repo").replaceAll("${{ env.HEAD_SHA }}", "head").replaceAll("${{ github.token }}", "job-token");
  const run = (checks: object[], extra: Record<string, string> = {}) => {
    writeFileSync(join(dir, "gh-args"), "");
    writeFileSync(join(dir, "github-env"), "");
    writeFileSync(join(dir, "github-output"), "");
    const result = Bun.spawnSync(["bash", "-ec", commands], { env: { ...env, ...extra, GH_TOKEN: "", CHECKS: JSON.stringify(checks), GITHUB_OUTPUT: join(dir, "github-output") } });
    expect(result.exitCode).toBe(0);
    return { args: readFileSync(join(dir, "gh-args"), "utf8"), env: readFileSync(join(dir, "github-env"), "utf8"), out: readFileSync(join(dir, "github-output"), "utf8"), err: result.stderr.toString() };
  };
  const handoff = run([{ id: 101, status: "queued", external_id: "pr-7", details_url: "" }]);
  expect(handoff.env).toContain("CHECK_ID=101");
  expect(handoff.out).toContain("fork-key=pr-7");
  expect(handoff.args).not.toContain("api repos/owner/repo/check-runs -f");
  // A review in another session still running on the same head keeps its check; publishing through it would overwrite its verdict.
  const live = run([{ id: 102, status: "in_progress", external_id: "", details_url: "https://github.com/owner/repo/actions/runs/222/job/9" }]);
  expect(live.env).toContain("CHECK_ID=303");
  expect(live.args).toContain("api repos/owner/repo/check-runs -f name=code-review");
  expect(live.err).toBe("");
  // Claiming a handoff preserves its external_id, but its new details URL identifies the live owner.
  const claimed = run([{ id: 104, status: "in_progress", external_id: "pr-7", details_url: "https://github.com/owner/repo/actions/runs/222/job/9" }]);
  expect(claimed.env).toContain("CHECK_ID=303");
  expect(claimed.out).not.toContain("fork-key=");
  // An unreadable owner or a queued rerun cannot establish that the check was abandoned.
  for (const owner of [333, 444]) {
    const pending = run([{ id: 105, status: "in_progress", external_id: "", details_url: `https://github.com/owner/repo/actions/runs/${owner}/job/9` }]);
    expect(pending.env).toContain("CHECK_ID=303");
    expect(pending.args).not.toContain("check-runs/105 -X PATCH");
  }
  // An abandoned job left its check behind, and the next review for that head continues it.
  const abandoned = run([{ id: 103, status: "in_progress", external_id: "", details_url: "https://github.com/owner/repo/actions/runs/111/job/9" }]);
  expect(abandoned.env).toContain("CHECK_ID=103");
  expect(abandoned.args).toContain("check-runs/103 -X PATCH");
  // A rerun of an interrupted attempt continues the check its previous attempt left behind, keeping the handoff key.
  const rerun = run([{ id: 106, status: "in_progress", external_id: "pr-7", details_url: "https://github.com/owner/repo/actions/runs/222/job/9?pr=7&attempt=1" }], { GITHUB_RUN_ID: "222", GITHUB_RUN_ATTEMPT: "2" });
  expect(rerun.env).toContain("CHECK_ID=106");
  expect(rerun.out).toContain("fork-key=pr-7");
  // Another review job in this attempt is still live.
  const sameAttempt = run([{ id: 107, status: "in_progress", external_id: "pr-7", details_url: "https://github.com/owner/repo/actions/runs/222/job/9?pr=7&attempt=2" }], { GITHUB_RUN_ID: "222", GITHUB_RUN_ATTEMPT: "2" });
  expect(sameAttempt.env).toContain("CHECK_ID=303");
  expect(sameAttempt.args).not.toContain("check-runs/107 -X PATCH");
});

test("tool output is greyed line by line", () => {
  // The log viewer styles each line on its own, so one escape around a block would leave every later line undimmed.
  const input = JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "bash -lc 'x'", aggregated_output: "one\ntwo\n\nthree\n" } });
  const result = Bun.spawnSync(["jq", "-Rr", "--arg", "stop", "s", "-f", join(root, "scripts/codex-log.jq")], { stdin: Buffer.from(input) });
  expect(result.exitCode).toBe(0);
  for (const line of ["one", "", "three"]) expect(result.stdout.toString()).toContain(`\n\u001b[90m${line}\u001b[0m\n`);
  // Only the shell prompt is grey; the command keeps its normal brightness.
  expect(result.stdout.toString()).toContain(`::group::\u001b[90m$\u001b[0m x\n`);
});

test("shell command titles cannot run workflow commands", () => {
  for (const payload of ["::error::forged", "\t::error::forged", "\u2003::error::forged", ":\r:error::forged", "CI ##[error]forged", "CI #\r#[error]forged"]) {
    // A heredoc can carry workflow commands without executing or printing them.
    const command = `bash -lc 'cat > /dev/null <<EOF\n${payload}\nEOF'`;
    for (const aggregated_output of ["", "done\n", "::warning::output\n"]) {
      const input = JSON.stringify({ type: "item.completed", item: { type: "command_execution", command, aggregated_output } });
      const result = Bun.spawnSync(["jq", "--unbuffered", "-rR", "--arg", "stop", "s", "-f", join(root, "scripts/codex-log.jq")], { stdin: Buffer.from(input) });
      expect(result.exitCode).toBe(0);
      const commands: string[] = [];
      let stopped = false;
      for (const line of result.stdout.toString().split("\n")) {
        const command = line.replace(/^[\s\u0085]+/, "").match(/^::([^ :]+).*?::/)?.[1]
          ?? line.match(/##\[([^ \]]+)[^\]]*\]/)?.[1];
        if (stopped) {
          if (command === "s") stopped = false;
        } else if (command === "stop-commands") stopped = true;
        else if (command) commands.push(command);
      }
      expect(commands).toEqual(["group", "endgroup"]);
      expect(stopped).toBe(false);
    }
  }
});

test("the verdict is coloured by its conclusion", () => {
  const log = (text: string) => {
    const input = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } });
    const result = Bun.spawnSync(["jq", "-Rr", "--arg", "stop", "s", "-f", join(root, "scripts/codex-log.jq")], { stdin: Buffer.from(input) });
    expect(result.exitCode).toBe(0);
    return result.stdout.toString();
  };
  const verdict = (conclusion: string) => JSON.stringify({ conclusion, summary: "s", commits: [] });
  expect(log(verdict("success"))).toContain(`\u001b[1;32m✓\u001b[0m {\u001b[36m"conclusion"\u001b[0m:\u001b[32m"success"\u001b[0m`);
  expect(log(verdict("failure"))).toContain(`\u001b[1;31m✗\u001b[0m {\u001b[36m"conclusion"\u001b[0m:\u001b[32m"failure"\u001b[0m`);
  // Prose and JSON that is not a verdict stay as written.
  for (const text of ["Working through the diff.", '{"hello":"world"}']) expect(log(text)).toContain(`${text}\n`);
});

test("the log carries no trailing whitespace", () => {
  const input = [
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "first line  \n\n   \nsecond line\t" } }),
    JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "bash -lc 'x  \r\n   \nnext\t'", aggregated_output: "out  \r\n\n  \n" } }),
    "raw stderr line with trailing spaces   ",
  ].join("\n") + "\n";
  const result = Bun.spawnSync(["jq", "-Rr", "--arg", "stop", "s", "-f", join(root, "scripts/codex-log.jq")], { stdin: Buffer.from(input) });
  expect(result.exitCode).toBe(0);
  const output = result.stdout.toString();
  expect(output).toContain("first line\n\n\nsecond line");
  expect(output).toContain("raw stderr line with trailing spaces\n");
  expect(output).not.toMatch(/[ \t]+\n/);
  expect(output.replace(/\u001b\[[0-9;]*m/g, "")).not.toMatch(/[ \t]+\n/);
  expect(output).not.toContain("\r");
});

test("log cleanup keeps workflow commands in command output escaped", () => {
  // The runner reads `::` commands after leading space and legacy `##[` commands anywhere in a line.
  for (const [output, expected] of [
    ["::error::test failure\n", "::error::test failure"],
    [":\r:error::test failure\r\n", "::error::test failure"],
    ["::err\ror::test failure\n", "::error::test failure"],
    ["CI ##[error]test failure\n", "CI ##[error]test failure"],
    ["out\n\t::error::test failure\n", "out\n\t::error::test failure"],
    ["out\n\u2003::error::test failure\n", "out\n\u2003::error::test failure"],
  ]) {
    const input = JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "bash -lc 'test'", aggregated_output: output } });
    const result = Bun.spawnSync(["jq", "-Rr", "--arg", "stop", "s", "-f", join(root, "scripts/codex-log.jq")], { stdin: Buffer.from(input) });
    expect(result.exitCode).toBe(0);
    const dimmed = expected.split("\n").map((line) => `\u001b[90m${line}\u001b[0m`).join("\n");
    expect(result.stdout.toString()).toContain(`\n::stop-commands::s\n${dimmed}\n::s::\n`);
  }
});

test("injected GitHub activity is logged with a colour per event kind", () => {
  const input = [
    JSON.stringify({ event: "issue_comment", action: "created", actor: "alice", url: "https://example.test/c/1" }),
    JSON.stringify({ event: "check_run", name: "CI", conclusion: "failure", url: "https://example.test/r/2" }),
    JSON.stringify({ event: "replay_gap", reason: "subscription_failed" }),
  ].join("\n") + "\n";
  const log = (input: string) => {
    const result = Bun.spawnSync(["jq", "-Rr", "-f", join(root, "scripts/injected-log.jq")], { stdin: Buffer.from(input) });
    expect(result.exitCode).toBe(0);
    return result.stdout.toString();
  };
  const output = log(input);
  expect(output).toContain("\u001b[96missue_comment/created\u001b[0m alice https://example.test/c/1");
  expect(output).toContain("\u001b[93mcheck_run\u001b[0m CI:failure https://example.test/r/2");
  expect(output).toContain("\u001b[91mreplay_gap\u001b[0m");
  // A payload field that carries a workflow command must not run as one, in either form the runner parses.
  // Escaping rather than stopping commands matters because the tool log that writes to the same stdout holds the runner's one suppression token.
  const crafted = log([
    JSON.stringify({ event: "check_run", name: "ci\n::error::forged", url: "https://example.test/r/3" }),
    JSON.stringify({ event: "check_run", name: "CI ##[error]synthetic", url: "https://example.test/r/4" }),
  ].join("\n") + "\n");
  expect(crafted).not.toContain("::stop-commands::");
  expect(crafted).not.toMatch(/^ *::/m);
  expect(crafted).not.toContain("##[");
  expect(crafted).toContain(":​:error:​:forged");
  expect(crafted).toContain("#​#[error]synthetic");
});

test("hook deliveries are published for the live log", () => {
  const { dir, output } = runHook(frame("issue_comment", { sender: human, issue: { number: 7, pull_request: {} }, comment: { id: 1, body: "hi", html_url: "https://example.test/c/1" } }, "writer", true));
  expect(JSON.parse(output).decision).toBe("block");
  expect(readFileSync(join(dir, "injected.log"), "utf8")).toContain('"event":"issue_comment"');
});

test("injected command markers stay escaped when concurrent output splits a line", () => {
  // A long record can span stdout writes; the tool logger may insert a newline before an interior marker.
  const { dir } = runHook(frame("check_run", { action: "completed", sender: bot, check_run: check({ name: `${"x".repeat(4096)}::error::forged\n:::error title=forged:::payload` }) }));
  const result = Bun.spawnSync(["jq", "-Rr", "-f", join(root, "scripts/injected-log.jq")], { stdin: Buffer.from(readFileSync(join(dir, "injected.log"))) });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).not.toContain("::");
});

test("injected command escaping covers the runner's leading whitespace", () => {
  // ActionCommand.TryParseV2 calls .NET TrimStart(), which also removes tabs and Unicode whitespace.
  for (const indent of ["", " ", "\t", "\v", "\f", "\u0085", "\u00a0", "\u1680", "\u2000", "\u2003", "\u2028", "\u2029", "\u202f", "\u205f", "\u3000", " \t "]) {
    const { dir } = runHook(frame("check_run", { action: "completed", sender: bot, check_run: check({ name: `CI\n${indent}::error::forged` }) }));
    const result = Bun.spawnSync(["jq", "-Rr", "-f", join(root, "scripts/injected-log.jq")], { stdin: Buffer.from(readFileSync(join(dir, "injected.log"))) });
    expect(result.exitCode).toBe(0);
    // Include U+0085 explicitly because JavaScript trimStart does not include it, whereas .NET does.
    const lines = result.stdout.toString().split("\n").map((line) => line.replace(/^[\s\u0085]+/, ""));
    expect(lines.some((line) => line.startsWith("::"))).toBe(false);
  }
});

test("codex is configured with the gh MCP server and the token config dir", () => {
  const { env } = fixture();
  const region = step("Configure codex").run.match(/printf '%s\\n' "\$CODEX_CONFIG"[\s\S]*?\n' "\$CODEX_HOME\/config\.toml"\n/)![0];
  const run = (config: string) => {
    const result = Bun.spawnSync(["bash", "-ec", region], { env: { ...env, CODEX_CONFIG: config, GITHUB_ACTION_PATH: root } });
    expect(result.exitCode).toBe(0);
    return Bun.TOML.parse(readFileSync(join(env.CODEX_HOME, "config.toml"), "utf8")) as any;
  };
  expect(run('model = "m"\n').mcp_servers.gh).toEqual({ command: "gh-mcp", env_vars: ["GH_CONFIG_DIR"] });
  // A supplied config that already names the server keeps its own definition instead of a duplicate table.
  expect(run('[mcp_servers.gh]\ncommand = "custom"\n').mcp_servers.gh).toEqual({ command: "custom" });
  expect(run('mcp_servers.gh = { command = "custom" }\n').mcp_servers.gh).toEqual({ command: "custom" });
  for (const config of [
    '  [mcp_servers.gh]\ncommand = "custom"\n',
    '[mcp_servers."gh"]\ncommand = "custom"\n',
    '[mcp_servers]\ngh = { command = "custom" }\n',
  ]) expect(run(config).mcp_servers.gh).toEqual({ command: "custom" });
  // An inline mcp_servers value cannot be extended by a table; the supplied config stays exactly as written.
  for (const key of ["mcp_servers", "  mcp_servers", "\tmcp_servers", '"mcp_servers"', "'mcp_servers'", '"mcp_\\u0073ervers"']) {
    expect(run(`${key} = { other = { command = "x" } }\n`).mcp_servers).toEqual({ other: { command: "x" } });
  }
  expect(run('[mcp_servers.other]\ncommand = "x"\n').mcp_servers).toEqual({ other: { command: "x" }, gh: { command: "gh-mcp", env_vars: ["GH_CONFIG_DIR"] } });
});

test("each run reports the tokens every turn spent", () => {
  const { dir, env } = fixture();
  writeFileSync(join(dir, "codex.jsonl"), [
    { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 8, output_tokens: 2, reasoning_output_tokens: 1 } },
    { type: "turn.completed", usage: { input_tokens: 5, cached_input_tokens: 0, output_tokens: 3, reasoning_output_tokens: 0 } },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n");
  const commands = step("Run codex review").run.match(/usage=\$\(jq[\s\S]*?echo "::notice::ChatGPT usage: \$usage"/)![0];
  const result = Bun.spawnSync(["bash", "-ec", commands], { env });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("ChatGPT usage: 15 input (8 cached), 5 output, 1 reasoning");
});

function gateStep() {
  return step("Skip activity another review already handled").run.replaceAll("${{ github.repository }}", "owner/repo");
}

function runGate(dir: string, env: Record<string, string>) {
  writeFileSync(join(dir, "github-env"), "");
  const result = Bun.spawnSync(["bash", "-c", gateStep()], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, RUNNER_TEMP: dir, CODEX_HOME: dir, GITHUB_ACTION_PATH: root, GITHUB_REPOSITORY: "owner/repo", GITHUB_ENV: join(dir, "github-env"), ...env }, timeout: 8000 });
  expect(result.exitCode).toBe(0);
  return readFileSync(join(dir, "github-env"), "utf8");
}

test("the action distinguishes commit statuses on the same SHA", async () => {
  const { dir, env } = fixture(), ids: string[] = [];
  for (const id of [1, 2, 1]) {
    writeFileSync(join(dir, "event.json"), JSON.stringify({ id, sha: "head", state: "success" }));
    const output = runGate(dir, { ...env, GITHUB_EVENT_NAME: "status", GITHUB_EVENT_PATH: join(dir, "event.json") });
    const expected = new Bun.CryptoHasher("sha256").update(`status::${id}:head:`).digest("hex").slice(0, 40);
    expect(output).toContain(`ACTIVITY_ID=${expected}`);
    ids.push(/ACTIVITY_ID=(.*)/.exec(output)![1]);
  }
  expect(ids[0]).not.toBe(ids[1]);
  expect(ids[0]).toBe(ids[2]);
});

test("the action distinguishes workflow attempts on the same SHA", () => {
  const { dir, env } = fixture();
  for (const attempt of [1, 2]) {
    writeFileSync(join(dir, "event.json"), JSON.stringify({ action: "completed", workflow_run: { id: 1, head_sha: "head", run_attempt: attempt } }));
    const output = runGate(dir, { ...env, GITHUB_EVENT_NAME: "workflow_run", GITHUB_EVENT_PATH: join(dir, "event.json") });
    const expected = new Bun.CryptoHasher("sha256").update(`workflow_run:completed:1:head:${attempt > 1 ? attempt : ""}`).digest("hex").slice(0, 40);
    expect(output).toContain(`ACTIVITY_ID=${expected}`);
  }
});

test("a repeated thread transition is not skipped as an older trigger", () => {
  const { dir, env } = fixture();
  mkdirSync(join(dir, "sessions"), { recursive: true });
  writeFileSync(join(dir, "event.json"), JSON.stringify({ action: "resolved", sender: human, pull_request: { number: 7 }, thread: { node_id: "thread", comments: [] } }));
  executable(dir, "gh", "#!/usr/bin/env bash\nprintf 'write\\n'\n");
  const vars = { ...env, GITHUB_EVENT_NAME: "pull_request_review_thread", GITHUB_EVENT_PATH: join(dir, "event.json") };
  const first = /ACTIVITY_ID=(.*)/.exec(runGate(dir, vars))![1];
  writeFileSync(join(dir, "sessions/.github-deliveries.json"), JSON.stringify([first]));
  expect(runGate(dir, { ...vars, GITHUB_RUN_ID: "13" })).not.toContain("SKIP=true");
});

test("review thread context derives resolution from the webhook action", () => {
  for (const action of ["resolved", "unresolved"]) {
    const { output } = runHook(frame("pull_request_review_thread", { action, pull_request: { number: 7 }, thread: { node_id: "thread", comments: [{ path: "file.ts", html_url: "https://github.com/owner/repo/pull/7#discussion_r1" }] } }, `webhook:${action}`));
    expect(output).toContain(`\\"resolved\\":${action === "resolved"}`);
    expect(output).toContain("discussion_r1");
  }
});

test("a review comment carries the id its answer replies to", () => {
  const { output } = runHook(frame("pull_request_review_comment", { action: "created", pull_request: { number: 7 }, comment: { id: 4242, body: "how do I fix it", path: "file.ts", line: 8 } }));
  expect(output).toContain('\\"comment_id\\":4242');
  expect(output).toContain("how do I fix it");
});

test("the action and the broker derive one id for a webhook, whatever it contains", () => {
  const { dir } = fixture();
  const payload = { action: "created", sender: human, issue: { number: 7, pull_request: {} }, comment: { id: 5, body: "del u007f: \u007f", updated_at: "2026-11-01T00:00:00Z" } };
  writeFileSync(join(dir, "event.json"), JSON.stringify(payload, null, 2));
  const key = ["pull_request", "created", 5, "", "2026-11-01T00:00:00Z"].join(":");
  type Crypto = { subtle: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> } };
  return (crypto as unknown as Crypto).subtle.digest("SHA-256", new TextEncoder().encode(key)).then((digest) => {
    const brokerId = [...new Uint8Array(digest).slice(0, 20)].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(runGate(dir, { GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: join(dir, "event.json") })).toContain(`ACTIVITY_ID=${brokerId}`);
  });
});

test("a run skips activity another review consumed, and strangers, but never a new head", () => {
  const setup = fixture();
  mkdirSync(join(setup.dir, "sessions"), { recursive: true });
  writeFileSync(join(setup.dir, "event.json"), JSON.stringify({ action: "created", sender: human, issue: { number: 7, pull_request: {} }, comment: { id: 1 } }));
  const env = { GITHUB_EVENT_NAME: "issue_comment", GITHUB_EVENT_PATH: join(setup.dir, "event.json"), PR_NUMBER: "7" };
  executable(setup.dir, "gh", "#!/usr/bin/env bash\nprintf 'write\\n'\n");
  const first = runGate(setup.dir, env);
  expect(first).toContain("ACTIVITY_WRITER=true");
  expect(first).not.toContain("SKIP=true");
  const id = /ACTIVITY_ID=(.*)/.exec(first)![1];
  writeFileSync(join(setup.dir, "sessions/.github-deliveries.json"), JSON.stringify([id]));
  expect(runGate(setup.dir, env)).not.toContain("SKIP=true");
  writeFileSync(join(setup.dir, "sessions/.github-published-head"), "head\n");
  expect(runGate(setup.dir, { ...env, HEAD_SHA: "head" })).toContain("SKIP=true");
  expect(runGate(setup.dir, { ...env, HEAD_SHA: "new" })).not.toContain("SKIP=true");
  writeFileSync(join(setup.dir, "sessions/.github-deliveries.json"), "[]");
  executable(setup.dir, "gh", "#!/usr/bin/env bash\nprintf 'read\\n'\n");
  expect(runGate(setup.dir, env)).toContain("SKIP=true");
  // A queued run for a new head must review it even if a running review already saw the push.
  writeFileSync(join(setup.dir, "push.json"), JSON.stringify({ ref: "refs/heads/main", after: "new", sender: human, repository: { full_name: "owner/repo" } }));
  const push = runGate(setup.dir, { GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: join(setup.dir, "push.json") });
  expect(push).toContain("ACTIVITY_ID=");
  expect(push).not.toContain("SKIP=true");
});
