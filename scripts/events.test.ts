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
const workflowJob = (overrides = {}) => ({ id: 200, run_id: 90, run_attempt: 1, head_sha: "head", name: "test", workflow_name: "CI", check_run_url: "https://api.github.com/repos/owner/repo/check-runs/100", ...overrides });
const frame = (event: string, body: object, delivery = event, writer = true) => `id: ${delivery}\ndata: ${JSON.stringify({ event, delivery, writer, body: JSON.stringify({ sender: human, ...body }) })}\n\n`;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "review-events-"));
  homes.push(dir);
  writeFileSync(join(dir, "sse.jsonl"), "");
  writeFileSync(join(dir, "injected.log"), "");
  writeFileSync(join(dir, "event.json"), "{}");
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, RUNNER_TEMP: dir, CODEX_HOME: dir, GITHUB_ACTION_PATH: root, GITHUB_ENV: join(dir, "github-env"),
    GITHUB_REPOSITORY: "owner/repo", EVENT_NAME: "", PR_NUMBER: "7", HEAD_SHA: "head", HEAD_BRANCH: "feature", GITHUB_REF: "refs/heads/main", BOT_LOGIN: "reviewer[bot]",
    CHECK_ID: "10", JOB_CHECK_RUN_ID: "11", REVIEW_HOSTED: "", GITHUB_RUN_ID: "12", GITHUB_WORKFLOW_REF: "owner/repo/.github/workflows/agent.yml@refs/heads/main",
    GITHUB_STEP_SUMMARY: join(dir, "summary.md"), DEFAULT_BRANCH: "main" };
  Object.assign(env, { GITHUB_EVENT_PATH: join(dir, "event.json") });
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

function runLoggedHook(log: string, overrides = {}) {
  const hook = runHook(log, overrides);
  const injected = readFileSync(join(hook.dir, "injected.log"), "utf8");
  const formatted = Bun.spawnSync(["jq", "-Rr", "-f", join(scripts, "injected-log.jq")], { env: { ...hook.env, ...overrides }, stdin: Buffer.from(injected) });
  expect(formatted.exitCode).toBe(0);
  expect(formatted.stderr.toString()).toBe("");
  const activities = injected.split("\n").filter(Boolean).map(line => JSON.parse(line));
  const contexts = JSON.parse(hook.output).reason.split("\n").slice(1, -1).map((line: string) => JSON.parse(line));
  expect(contexts).toEqual(activities.map(({ workflow, ...context }) => context));
  return { ...hook, contexts, activities, text: formatted.stdout.toString().replace(/\u001b\[[0-9;]*m/g, "") };
}

type CIResponse = { pages?: object[]; error?: string };

function runCI(responses: CIResponse[], events = "", args: string[] = [], extraEnv: Record<string, string> = {}, workflowResponses: CIResponse[] = []) {
  const setup = fixture();
  writeFileSync(join(setup.dir, "sse.jsonl"), events);
  writeFileSync(join(setup.dir, "responses.json"), JSON.stringify(responses));
  writeFileSync(join(setup.dir, "workflow-responses.json"), JSON.stringify(workflowResponses));
  executable(setup.dir, "gh", `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const dir = process.env.RUNNER_TEMP;
const argv = process.argv.slice(2);
appendFileSync(dir + "/gh-args", JSON.stringify(argv) + "\\n");
if (!argv.includes("--paginate")) { console.error("missing pagination"); process.exit(1); }
if (argv.includes("--slurp")) { console.error("unknown flag: --slurp"); process.exit(1); }
if (argv[1].includes("/actions/workflows/")) {
  if (process.env.WORKFLOW_LOOKUP_FAIL === "1") { console.error("HTTP 404"); process.exit(1); }
  console.log(JSON.stringify({ id: process.env.WORKFLOW_LOOKUP_BAD_ID === "1" ? "42" : 42, path: process.env.WORKFLOW_LOOKUP_PATH || ".github/workflows/agent.yml" }));
  process.exit(0);
}
const actions = argv[1].includes("/actions/runs");
const countFile = dir + (actions ? "/workflow-calls" : "/calls");
const count = existsSync(countFile) ? Number(readFileSync(countFile, "utf8")) : 0;
writeFileSync(countFile, String(count + 1));
const response = JSON.parse(readFileSync(dir + (actions ? "/workflow-responses.json" : "/responses.json"), "utf8"))[count]
  ?? (actions ? { pages: [argv[1].includes("?") ? { workflow_runs: [] } : { workflow_id: 42 }] } : undefined);
if (!response) { console.error("unexpected API call"); process.exit(1); }
if (response.pages) for (const page of response.pages) console.log(JSON.stringify(page));
if (response.error) { console.error(response.error); process.exit(1); }
`);
  // Keep the actual jq evaluator: mocking its JSON output would hide broken filters.
  executable(setup.dir, "jq", `#!/usr/bin/env bash\nprintf 'called\\n' >> "$RUNNER_TEMP/jq-calls"\nexec '${realJq}' "$@"\n`);
  executable(setup.dir, "tail", `#!/usr/bin/env bash\nprintf '%s' "$$" > "$RUNNER_TEMP/tail-pid"\nexec '${realTail}' "$@"\n`);
  const result = Bun.spawnSync(["bash", join(scripts, "wait-ci.sh"), "head", ...args], { env: { ...setup.env, GH_CONFIG_DIR: join(setup.dir, "gh-config"), GH_TOKEN: "", GITHUB_TOKEN: "", ACTIONS_TOKEN: "", ...extraEnv }, timeout: Math.max(3000, (Number(extraEnv.WAIT_CI_TIMEOUT) || 0) * 1000 + 2000) });
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

test("an interrupted subscription requests GitHub reconciliation once without trusting recovered instructions", () => {
  const recovery = `event: subscription_recovery\ndata: ${JSON.stringify({ event: "subscription_recovery", delivery: "subscription:12:1:3:connection_failed", writer: false, body: JSON.stringify({ reason: "connection_failed", status: "0" }) })}\n\n`;
  const { output, run } = runHook(recovery);
  expect(JSON.parse(output).decision).toBe("block");
  expect(output).toContain("subscription_recovery");
  expect(output).toContain("GitHub");
  expect(output).toContain("write access");
  expect(run().stdout.toString()).toBe("");
  expect(parseFrames(recovery)).toBe(recovery);
});

test("a stopped subscriber cannot silently leave the review on a stale snapshot", () => {
  const { env, output } = runHook(frame("subscription_recovery", { reason: "subscription_failed", status: "1" }, "stopped"));
  expect(output).toContain("subscription_failed");
  // The stop travels on the stream, so it is delivered once: a later run has already been told.
  const retry = Bun.spawnSync(["bash", join(scripts, "review-hook.sh")], { env: { ...env, GITHUB_RUN_ID: "13" }, stdin: Buffer.from('{"hook_event_name":"Stop"}') });
  expect(retry.exitCode).toBe(0);
  expect(retry.stdout.toString()).toBe("");
});

test("subscription control frames do not break CI waiting or publishing newer heads", () => {
  const recovery = `event: subscription_recovery\ndata: ${JSON.stringify({ event: "subscription_recovery", delivery: "subscription:head", writer: false, body: JSON.stringify({ reason: "connection_failed" }) })}\n\n`;
  const ci = runCI([{ pages: [{ check_runs: [check({ status: "in_progress" })] }] }, { pages: [{ check_runs: [check()] }] }], recovery + frame("status", { sha: "head", state: "success" }));
  expect(ci.result.exitCode).toBe(0); expect(ci.calls).toBe(2); expectTailReleased(ci.dir);
  const { dir, env } = fixture();
  writeFileSync(join(dir, "sse.jsonl"), recovery + frame("pull_request", { action: "synchronize", number: 7, after: "newer" }));
  const publish = step("Publish check run").run.split("# Pushes made")[0] + '\nprintf "%s" "$PUSHED"';
  const result = Bun.spawnSync(["bash", "-ec", publish], { env });
  expect(result.exitCode).toBe(0); expect(result.stdout.toString()).toBe("newer");
});

test("consumption receipts cover delivered activity, never filtered events or later arrivals", () => {
  const one = frame("issue_comment", { issue: { number: 7 }, comment: { body: "first" } }, "first", true);
  const two = frame("issue_comment", { issue: { number: 8 }, comment: { body: "other PR" } }, "second", true);
  const { dir, output } = runHook(one + two);
  expect(output).toContain("first");
  expect(output).not.toContain("other PR");
  writeFileSync(join(dir, "sse.jsonl"), one + two + frame("status", { sha: "head", state: "failure" }, "later", false));
  expect(readFileSync(join(dir, "injected-deliveries.log"), "utf8")).toBe("first\n");
});

test("check runs whose suite belongs to a sibling run of this workflow stay out of the context", () => {
  const own = ".github/workflows/agent.yml";
  const { output } = runHook([
    // The sibling run announces its check suite before its jobs finish.
    frame("workflow_run", { action: "requested", workflow_run: { id: 90, name: "agent invoke", path: own, head_sha: "head", check_suite_id: 500 } }, "sibling-run"),
    frame("check_run", { action: "completed", check_run: check({ id: 91, name: "agent / agent", conclusion: "skipped", check_suite: { id: 500 } }) }, "sibling"),
    // Another workflow may name its job the same way; its suite is its own.
    frame("check_run", { action: "completed", check_run: check({ id: 92, name: "agent / tests", conclusion: "failure", check_suite: { id: 501 } }) }, "other-workflow"),
    // A suite no workflow run announced stays: unknown provenance must never hide failed CI.
    frame("check_run", { action: "completed", check_run: check({ id: 93, name: "test", check_suite: { id: 502 } }) }, "ci"),
  ].join(""));
  expect(output).not.toContain("agent / agent");
  expect(output).toContain("agent / tests");
  expect(output).toContain("test");
});

test("workflow runs are identified by their path, not their display name", () => {
  const workflow = (path?: string) => ({ id: 90, head_sha: "head", name: "agent invoke", path, conclusion: "failure" });
  const env = { GITHUB_WORKFLOW: "agent invoke" };
  expect(runHook(frame("workflow_run", { action: "completed", workflow_run: workflow(".github/workflows/agent.yml") }), env).output).toBe("");
  for (const path of [".github/workflows/ci.yml", undefined]) {
    const { output } = runHook(frame("workflow_run", { action: "completed", workflow_run: workflow(path) }), env);
    expect(output).toContain("failure");
  }
});

test("check runs without a details URL do not prevent activity delivery", () => {
  const { output } = runHook([
    frame("check_run", { action: "completed", check_run: check({ conclusion: "failure" }) }),
    frame("issue_comment", { issue: { number: 7 }, comment: { body: "Please check this regression" } }),
  ].join(""));
  expect(output).toContain("failure");
  expect(output).toContain("Please check this regression");
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

test("discussion needs write access, and only review activity admits Bot senders", () => {
  for (const event of ["issue_comment", "pull_request_review", "pull_request_review_comment", "pull_request_review_thread"]) {
    const body = { action: "resolved", pull_request: { number: 7 }, thread: { resolved: true, comments: [{ path: "file.ts", line: 8 }] } };
    expect(runHook(frame(event, body, "no-write", false)).output).toBe("");
    expect(runHook(frame(event, { ...body, sender: bot }, "bot", false)).output.includes(event)).toBe(event !== "issue_comment");
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

test("duplicate live deliveries are deduplicated within one Stop and across Stops", () => {
  const event = frame("issue_comment", { issue: { number: 7 }, comment: { body: "once-only" } }, "same-delivery");
  const { output, run, dir } = runHook(event + event);
  expect(output.match(/once-only/g)).toHaveLength(1);
  expect(run().stdout.toString()).toBe("");
  expect(readFileSync(join(dir, "injected-deliveries.log"), "utf8")).toBe("same-delivery\n");
});

test("failed hook output leaves activity replayable", () => {
  const setup = fixture();
  writeFileSync(join(setup.dir, "sse.jsonl"), frame("issue_comment",
    { action: "created", issue: { number: 7 }, comment: { body: "replayed" } }, "retry-delivery"));
  const hook = join(scripts, "review-hook.sh");
  const failed = Bun.spawnSync(["bash", "-c", 'bash "$HOOK" >/dev/full'], {
    env: { ...setup.env, HOOK: hook }, stdin: Buffer.from('{"hook_event_name":"Stop"}'), timeout: 3000,
  });
  expect(failed.exitCode).not.toBe(0);
  expect(existsSync(join(setup.dir, "injected-deliveries.log"))).toBe(false);
  const retried = Bun.spawnSync(["bash", hook], {
    env: setup.env, stdin: Buffer.from('{"hook_event_name":"Stop"}'), timeout: 3000,
  });
  expect(retried.exitCode).toBe(0);
  expect(retried.stdout.toString()).toContain("replayed");
  expect(readFileSync(join(setup.dir, "injected-deliveries.log"), "utf8")).toBe("retry-delivery\n");
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
  const stop = Bun.spawnSync(["bash", join(scripts, "review-hook.sh")], { env: setup.env, stdin: Buffer.from('{"hook_event_name":"Stop"}'), timeout: 3000 });
  expect(stop.stdout.toString()).toContain("parent-only");
});

test.each([false, true])("parallel tool rounds serialize delivery with a legacy lock directory: %j", async legacy => {
  const setup = fixture();
  if (legacy) mkdirSync(join(setup.dir, "injected-deliveries.lock"));
  writeFileSync(join(setup.dir, "sse.jsonl"), frame("issue_comment", { action: "created", issue: { number: 7 }, comment: { body: "concurrent" } }, "concurrent", true));
  const rounds = Array.from({ length: 4 }, () => Bun.spawn(["bash", join(scripts, "review-hook.sh")], { env: setup.env, stdin: Buffer.from('{"hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"ls"}}'), stdout: "pipe", stderr: "pipe", timeout: 3000 }));
  const outputs = await Promise.all(rounds.map(async child => {
    const [output, error, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exitCode).toBe(0);
    expect(error).toBe("");
    return output;
  }));
  expect(outputs.filter(output => output.includes("concurrent"))).toHaveLength(1);
  expect(readFileSync(join(setup.dir, "injected-deliveries.log"), "utf8")).toBe("concurrent\n");
  const stop = Bun.spawnSync(["bash", join(scripts, "review-hook.sh")], { env: setup.env, stdin: Buffer.from('{"hook_event_name":"Stop"}'), timeout: 3000 });
  expect(stop.stdout.toString()).toBe("");
});

async function waitForHookFile(path: string) {
  for (const deadline = performance.now() + 3000; !existsSync(path) && performance.now() < deadline;) await Bun.sleep(5);
  expect(existsSync(path)).toBe(true);
}

function holdHook() {
  const setup = fixture();
  writeFileSync(join(setup.dir, "sse.jsonl"), frame("issue_comment", { issue: { number: 7 }, comment: { body: "pending" } }, "pending"));
  executable(setup.dir, "jq", `#!/usr/bin/env bash
if [ "$1" = -Rrs ]; then
  printf '%s\\n' "\${HOLD_HOOK:-waiter}" >> "$RUNNER_TEMP/hook-entries"
  if [ "\${HOLD_HOOK:-}" = owner ]; then
    printf '%s\\n' "$$" > "$RUNNER_TEMP/hook-jq-pid"
    : > "$RUNNER_TEMP/hook-ready"
    while [ ! -f "$RUNNER_TEMP/hook-release" ]; do
      [ "$SECONDS" -lt 12 ] || exit 1
      sleep 0.01
    done
    '${realJq}' "$@"
    code=$?
    : > "$RUNNER_TEMP/hook-jq-finished"
    exit "$code"
  fi
fi
exec '${realJq}' "$@"
`);
  const owner = Bun.spawn(["bash", join(scripts, "review-hook.sh")], {
    env: { ...setup.env, HOLD_HOOK: "owner" }, stdin: Buffer.from('{"hook_event_name":"Stop"}'), stdout: "pipe", stderr: "pipe", timeout: 10000,
  });
  const output = new Response(owner.stdout).text(), error = new Response(owner.stderr).text();
  const release = () => writeFileSync(join(setup.dir, "hook-release"), "");
  return { ...setup, owner, output, error, release, async cleanup() {
    release();
    if (owner.exitCode === null) owner.kill("SIGKILL");
    await Promise.all([owner.exited, output, error]);
  } };
}

test.each(["SIGTERM", "SIGKILL"] as const)("a %s owner releases delivery while its read-only child is still alive", async signal => {
  const hook = holdHook();
  try {
    await waitForHookFile(join(hook.dir, "hook-ready"));
    hook.owner.kill(signal);
    expect(await hook.owner.exited).not.toBe(0);
    const orphan = readFileSync(join(hook.dir, "hook-jq-pid"), "utf8").trim();
    expect(Bun.spawnSync(["bash", "-c", 'kill -0 "$1"', "_", orphan]).exitCode).toBe(0);
    expect(existsSync(join(hook.dir, "injected-deliveries.log"))).toBe(false);
    const rounds = Array.from({ length: 4 }, () => Bun.spawn(["bash", join(scripts, "review-hook.sh")], {
      env: hook.env, stdin: Buffer.from('{"hook_event_name":"Stop"}'), stdout: "pipe", stderr: "pipe", timeout: 3000,
    }));
    const outputs = await Promise.all(rounds.map(async child => {
      const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(code).toBe(0); expect(error).toBe(""); return output;
    }));
    expect(outputs.filter(output => output.includes("pending"))).toHaveLength(1);
    const receipts = readFileSync(join(hook.dir, "injected-deliveries.log"), "utf8");
    const log = readFileSync(join(hook.dir, "injected.log"), "utf8");
    expect(receipts).toBe("pending\n");
    hook.release();
    await waitForHookFile(join(hook.dir, "hook-jq-finished"));
    expect(await hook.output).toBe("");
    expect(readFileSync(join(hook.dir, "injected-deliveries.log"), "utf8")).toBe(receipts);
    expect(readFileSync(join(hook.dir, "injected.log"), "utf8")).toBe(log);
  } finally { await hook.cleanup(); }
});

test("a live owner makes waiters time out without entering or consuming pending activity", async () => {
  const hook = holdHook();
  try {
    await waitForHookFile(join(hook.dir, "hook-ready"));
    const started = performance.now();
    const waiter = Bun.spawnSync(["bash", join(scripts, "review-hook.sh")], {
      env: hook.env, stdin: Buffer.from('{"hook_event_name":"Stop"}'), timeout: 7000,
    });
    expect(waiter.exitCode).toBe(1);
    expect(waiter.stderr.toString()).toContain("Timed out waiting for the review hook delivery lock");
    expect(performance.now() - started).toBeGreaterThanOrEqual(4500);
    expect(waiter.stdout.toString()).toBe("");
    expect(readFileSync(join(hook.dir, "hook-entries"), "utf8")).toBe("owner\n");
    expect(existsSync(join(hook.dir, "injected-deliveries.log"))).toBe(false);
    expect(existsSync(join(hook.dir, "injected.size"))).toBe(false);
    hook.owner.kill("SIGKILL");
    await hook.owner.exited;
    const retried = Bun.spawnSync(["bash", join(scripts, "review-hook.sh")], {
      env: hook.env, stdin: Buffer.from('{"hook_event_name":"Stop"}'), timeout: 3000,
    });
    expect(retried.exitCode).toBe(0);
    expect(retried.stdout.toString()).toContain("pending");
    expect(readFileSync(join(hook.dir, "injected-deliveries.log"), "utf8")).toBe("pending\n");
  } finally { await hook.cleanup(); }
}, 10000);

test("activity links drop this repository's prefix and keep external ones", () => {
  const log = [
    frame("issue_comment", { action: "created", issue: { number: 7 }, comment: { body: "inside", html_url: "https://github.com/owner/repo/pull/7#issuecomment-1" } }, "inside"),
    frame("issue_comment", { action: "created", issue: { number: 7 }, comment: { body: "other repo", html_url: "https://github.com/owner/repo2/pull/7#issuecomment-2" } }, "other"),
    frame("check_run", { action: "completed", check_run: check({ details_url: "https://ci.example.test/run/1" }) }, "external"),
  ].join("");
  const { output } = runHook(log);
  expect(output).toContain('\\"html_url\\":\\"/pull/7#issuecomment-1\\"');
  expect(output).toContain('\\"html_url\\":\\"https://github.com/owner/repo2/pull/7#issuecomment-2\\"');
  expect(output).toContain('\\"details_url\\":\\"https://ci.example.test/run/1\\"');
});

test("an edited pull request title and body reach the review", () => {
  const { output } = runHook(frame("pull_request", { action: "edited", pull_request: { number: 7, title: "New title", body: "New description", head: { sha: "head" } } }, "edit"));
  expect(output).toContain('\\"title\\":\\"New title\\"');
  expect(output).toContain('\\"body\\":\\"New description\\"');
});

test.each([null, ""])("clearing a PR description preserves an explicit empty body (%j)", (body) => {
  const { output } = runHook(frame("pull_request", { action: "edited", pull_request: { number: 7, title: "Unchanged title", body, head: { sha: "head" } } }, "clear-description"));
  const activity = JSON.parse(JSON.parse(output).reason.split("\n")[1]);
  expect(activity.pull_request.body).toBe("");
});

test("a truncated edit says so instead of hiding the change", () => {
  const body = "x".repeat(2000) + "TAIL";
  const { output } = runHook(frame("pull_request", { action: "edited", pull_request: { number: 7, title: "t".repeat(201), body, head: { sha: "head" } } }, "long-edit"));
  expect(output).toContain("truncated at 2000 of 2004 characters");
  expect(output).not.toContain("TAIL");
  expect(output).toContain("truncated at 200 of 201 characters");
});

test("another app's review activity reaches the review, while its issue comments do not", () => {
  const other = { login: "coderabbitai[bot]", type: "Bot" };
  const review = (sender: object, text: string) => frame("pull_request_review_comment", { action: "created", pull_request: { number: 7 }, comment: { path: "a.ts", line: 3, body: text }, sender }, "bot-review", false);
  const included = runHook(review(other, "bot finding")).output;
  expect(included).toContain("bot finding");
  expect(included).toContain('\\"type\\":\\"Bot\\"');
  expect(runHook(review({ login: "reviewer[bot]", type: "Bot" }, "own finding")).output).toBe("");
  expect(runHook(review(human, "stranger finding")).output).toBe("");
  expect(runHook(frame("issue_comment", { action: "created", issue: { number: 7 }, comment: { body: "bot chatter" }, sender: other }, "bot-chatter", false)).output).toBe("");
});

test("a failed context write leaves the event available for the next Stop", async () => {
  const { dir, env } = fixture();
  writeFileSync(join(dir, "sse.jsonl"), frame("issue_comment", { action: "created", issue: { number: 7 }, comment: { body: "pending-event" } }, "pending-event", true));
  const child = Bun.spawn(["bash", join(scripts, "review-hook.sh")], { env, stdin: Buffer.from('{"hook_event_name":"Stop"}'), stdout: "pipe", stderr: "pipe" });
  await child.stdout.cancel();
  expect(await child.exited).not.toBe(0);
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

test("another run of this workflow is excluded without a separate Actions token", () => {
  const { result, dir, calls } = runCI([
    { pages: [{ check_runs: [check(), check({ id: 101, status: "queued", check_suite: { id: 7 } })] }] },
  ], "", [".", "pass"], { WAIT_CI_TIMEOUT: "1" }, [
    { pages: [{ workflow_id: 42 }] },
    { pages: [{ workflow_runs: [{ id: 1, workflow_id: 42, check_suite_id: 7 }] }] },
  ]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe("test: success\n");
  expect(calls).toBe(1);
});

test("a queued check from another workflow still blocks the wait", () => {
  const { result, dir } = runCI([
    { pages: [{ check_runs: [check(), check({ id: 101, status: "queued", check_suite: { id: 9 } })] }] },
  ], "", [".", "pass"], { WAIT_CI_TIMEOUT: "1" }, [
    { pages: [{ workflow_id: 42 }] },
    { pages: [{ workflow_runs: [{ id: 1, workflow_id: 42, check_suite_id: 7 }] }] },
  ]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("No CI checks matching");
  expectTailReleased(dir);
});

test("this run's own other jobs are still CI", () => {
  const { result, dir } = runCI([
    { pages: [{ check_runs: [check({ status: "in_progress", check_suite: { id: 7 } }), check({ id: 101, status: "queued", check_suite: { id: 8 } })] }] },
  ], "", [".", "pass"], { WAIT_CI_TIMEOUT: "1" }, [
    { pages: [{ workflow_id: 42 }] },
    { pages: [{ workflow_runs: [{ id: 12, workflow_id: 42, check_suite_id: 7 }, { id: 1, workflow_id: 42, check_suite_id: 8 }] }] },
  ]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("No CI checks matching");
  expectTailReleased(dir);
});

test.each(["workflow", "runs"])("unreadable %s keeps queued checks in the wait", (lookup) => {
  const workflowResponses = lookup === "workflow"
    ? [{ error: "HTTP 403: Actions unavailable" }]
    : [{ pages: [{ workflow_id: 42 }] }, { pages: [{ workflow_runs: [{ id: 1, workflow_id: 42, check_suite_id: 7 }] }], error: "HTTP 502: later page failed" }];
  const { result, dir } = runCI([
    { pages: [{ check_runs: [check(), check({ id: 101, status: "queued", check_suite: { id: 7 } })] }] },
  ], "", [".", "pass"], { WAIT_CI_TIMEOUT: "1" }, workflowResponses);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("No CI checks matching");
  if (lookup === "workflow") expect(result.stdout.toString()).toContain("other runs are not readable");
  expectTailReleased(dir);
});

test("unavailable Actions access still allows completed CI to pass", () => {
  const { result } = runCI([{ pages: [{ check_runs: [check()] }] }], "", [".", "pass"], {}, [{ error: "HTTP 403: Actions unavailable" }]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("test: success");
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

test("heartbeats do not re-read the API, while a recovery frame does", () => {
  const { dir, env } = fixture();
  executable(dir, "gh", `#!${process.execPath}\nimport { appendFileSync, existsSync, writeFileSync } from "node:fs";\nif (process.argv[3].includes("/actions/runs")) { console.log(JSON.stringify(process.argv[3].includes("?") ? { workflow_runs: [] } : { workflow_id: 42 })); process.exit(0); }\nconst dir = process.env.RUNNER_TEMP;\nconst marker = dir + "/checked";\nif (existsSync(marker) && !existsSync(dir + "/recovery")) { console.error("API read before recovery"); process.exit(1); }\nappendFileSync(dir + "/gh-calls", "call\\n");\nconsole.log(JSON.stringify({ check_runs: existsSync(marker) ? [${JSON.stringify(check())}] : [] }));\nwriteFileSync(marker, "yes");\n`);
  executable(dir, "tail", `#!${process.execPath}\nimport { writeFileSync } from "node:fs";\nwriteFileSync(process.env.RUNNER_TEMP + "/tail-pid", String(process.pid));\nlet pings = 0;\nsetInterval(() => { if (++pings === 3) { writeFileSync(process.env.RUNNER_TEMP + "/recovery", "yes"); console.log("event: subscription_recovery"); } else console.log(": ping"); }, 50);\n`);
  const result = Bun.spawnSync(["bash", join(scripts, "wait-ci.sh"), "head"], { env: { ...env, WAIT_CI_TIMEOUT: "2" }, timeout: 4000 });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("test: success");
  // Only the opening read and the one the recovery frame asks for reach the API.
  expect(readFileSync(join(dir, "gh-calls"), "utf8").trim().split("\n")).toHaveLength(2);
  expectTailReleased(dir);
});

test("a dead subscription still reconciles with the API before the deadline", () => {
  const { dir, env } = fixture();
  executable(dir, "gh", `#!${process.execPath}\nimport { existsSync, writeFileSync } from "node:fs";\nif (process.argv[3].includes("/actions/runs")) { console.log(JSON.stringify(process.argv[3].includes("?") ? { workflow_runs: [] } : { workflow_id: 42 })); process.exit(0); }\nconst dir = process.env.RUNNER_TEMP;\nconst marker = dir + "/checked";\nconsole.log(JSON.stringify({ check_runs: existsSync(marker) ? [${JSON.stringify(check())}] : [] }));\nwriteFileSync(marker, "yes");\n`);
  // The subscriber gave up and said so on the stream; nothing will announce the checks it never delivered.
  writeFileSync(join(dir, "sse.jsonl"), frame("subscription_recovery", { reason: "subscription_failed", status: "1" }, "stopped"));
  const result = Bun.spawnSync(["bash", join(scripts, "wait-ci.sh"), "head"], { env: { ...env, WAIT_CI_TIMEOUT: "4" }, timeout: 6000 });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("test: success");
});

test("a dead subscription and closed tail delay API retries", () => {
  const { dir, env } = fixture();
  executable(dir, "gh", `#!${process.execPath}
import { existsSync, readFileSync, writeFileSync } from "node:fs";
if (process.argv[3].includes("/actions/runs")) { console.log(JSON.stringify(process.argv[3].includes("?") ? { workflow_runs: [] } : { workflow_id: 42 })); process.exit(0); }
const path = process.env.RUNNER_TEMP + "/calls";
const calls = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
calls.push(Date.now()); writeFileSync(path, JSON.stringify(calls));
console.log(JSON.stringify({ check_runs: calls.length >= 4 ? [${JSON.stringify(check())}] : [] }));
`);
  executable(dir, "tail", `#!/usr/bin/env bash\nprintf '%s' "$$" > "$RUNNER_TEMP/tail-pid"\ncat "$RUNNER_TEMP/sse.jsonl"\n`);
  writeFileSync(join(dir, "sse.jsonl"), `event: subscription_recovery\n` + frame("subscription_recovery", { reason: "subscription_failed", status: "1" }, "stopped"));
  const result = Bun.spawnSync(["bash", join(scripts, "wait-ci.sh"), "head"], { env: { ...env, WAIT_CI_TIMEOUT: "6" }, timeout: 8000 });
  expect(result.exitCode).toBe(0);
  const calls = JSON.parse(readFileSync(join(dir, "calls"), "utf8"));
  expect(calls).toHaveLength(4);
  expect(calls[3] - calls[2]).toBeGreaterThanOrEqual(1000);
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

test("a failed SSE write fails the parser", async () => {
  const { env } = fixture();
  const child = Bun.spawn(["bash", join(scripts, "sse-frames.sh")], {
    env, stdin: Buffer.from(frame("status", { sha: "head", state: "success" }, "unwritten")), stdout: "pipe", stderr: "pipe",
  });
  await child.stdout.cancel();
  expect(await child.exited).not.toBe(0);
});

test("SSE frames reach readers while the connection remains open", async () => {
  const { dir, env } = fixture(), response = join(dir, "response");
  const event = frame("status", { sha: "head", state: "success" }, "live");
  const child = Bun.spawn(["bash", join(scripts, "sse-frames.sh"), response], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  child.stdin.write("HTTP/2 200\r\ncontent-type: text/event-stream\r\n\r\n" + event);
  child.stdin.flush();
  try {
    const reader = child.stdout.getReader();
    const output = (async () => { let text = ""; while (!text.includes(event)) { const chunk = await reader.read(); if (chunk.done) break; text += new TextDecoder().decode(chunk.value); } return text; })();
    expect(await Promise.race([output, Bun.sleep(3000).then(() => "timeout")])).toBe(event);
    expect(readFileSync(response, "utf8")).toBe("200 text/event-stream\n");
  } finally {
    child.stdin.end();
    child.kill();
    await child.exited;
  }
});

test("HTTP framing skips informational headers before accepting an HTTP/2 event stream", () => {
  const { dir, env } = fixture(), response = join(dir, "response");
  const event = frame("status", { sha: "head", state: "success" }, "accepted");
  const headers = "HTTP/1.1 103 Early Hints\r\nLink: </asset>\r\n\r\nHTTP/2 200\r\ncOnTeNt-TyPe: Text/Event-Stream ; charset=utf-8\r\n\r\n";
  const result = Bun.spawnSync(["bash", join(scripts, "sse-frames.sh"), response], { env, stdin: Buffer.from(headers + event) });
  expect(result.exitCode).toBe(0); expect(result.stdout.toString()).toBe(event);
  expect(readFileSync(response, "utf8")).toBe("200 text/event-stream\n");
});

test("the subscription survives 360 HTTP failures and stops all its own children", async () => {
  const { dir, env } = fixture();
  executable(dir, "sleep", "#!/usr/bin/env bash\nexit 0\n");
  let requests = 0;
  const cursors: (string | null)[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    requests++; cursors.push(request.headers.get("last-event-id"));
    if (requests <= 360) return new Response("UNAVAILABLE BODY MUST NOT BECOME AN EVENT", { status: 503 });
    return new Response(requests === 361 ? frame("status", { sha: "head", state: "success" }, "restored") : new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(": ping\n\n")); } }), { headers: { "content-type": "text/event-stream" } });
  } });
  const child = Bun.spawn(["bash", join(scripts, "subscribe.sh")], { env: { ...env, EVENTS_URL: `${server.url}?fixture=1` }, stdout: "pipe", stderr: "pipe" });
  try {
    const deadline = performance.now() + 15_000;
    while (requests < 362 && child.exitCode === null && performance.now() < deadline) await Bun.sleep(10);
    expect(requests).toBeGreaterThanOrEqual(362);
    expect(cursors.every(cursor => cursor === null)).toBe(true);
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
    expect(readFileSync(join(dir, "sse.jsonl"), "utf8")).not.toContain("subscription_failed");
  } finally { if (child.exitCode === null) child.kill("SIGTERM"); await child.exited; server.stop(true); }
}, 20_000);

test.each([false, true])("a failed stream writer records a visible terminal failure with curl still running: %j", running => {
  const { dir, env } = fixture();
  executable(dir, "curl", `#!/usr/bin/env bash\n${running ? `exec '${realSleep}' 60` : "exit 0"}\n`);
  executable(dir, "awk", "#!/usr/bin/env bash\nexit 1\n");
  const child = Bun.spawnSync(["bash", join(scripts, "subscribe.sh")], { env: { ...env, EVENTS_URL: "https://example.test/?fixture=1" }, timeout: 3000 });
  expect(child.exitCode).toBe(1);
  expect(readFileSync(join(dir, "sse.jsonl"), "utf8")).toContain("subscription_failed");
});

test("a live reconnect reconciles the whole outage and a later disconnect is fresh activity", async () => {
  const { dir, env } = fixture();
  executable(dir, "sleep", `#!/usr/bin/env bash\nexec '${realSleep}' 0.02\n`);
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  let requests = 0, reconnect!: (response: Response) => void;
  const response = () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
    streams.push(controller);
    controller.enqueue(new TextEncoder().encode(": ping\n\n"));
  } }), { headers: { "content-type": "text/event-stream" } });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    requests++;
    if (requests === 1) return response();
    return new Promise<Response>(resolve => { reconnect = resolve; });
  } });
  const child = Bun.spawn(["bash", join(scripts, "subscribe.sh")], { env: { ...env, EVENTS_URL: `${server.url}?fixture=1` }, stdout: "pipe", stderr: "pipe" });
  const log = () => readFileSync(join(dir, "sse.jsonl"), "utf8");
  const until = async (condition: () => boolean) => {
    for (const deadline = performance.now() + 2000; !condition() && performance.now() < deadline;) await Bun.sleep(5);
    expect(condition()).toBe(true);
  };
  const hook = () => {
    const result = Bun.spawnSync(["bash", join(scripts, "review-hook.sh")], { env, stdin: Buffer.from('{"hook_event_name":"Stop"}') });
    expect(result.exitCode).toBe(0);
    return result.stdout.toString();
  };
  try {
    await until(() => log().includes(": ping"));
    expect(log()).not.toContain("subscription_recovery");
    streams[0]!.close();
    await until(() => requests === 2 && log().includes("connection_failed"));
    expect(hook()).toContain("connection_failed");
    expect(hook()).toBe("");
    // The first recovery read happened before the new connection was established.
    reconnect(response());
    await until(() => log().includes("connection_restored"));
    expect(child.exitCode).toBeNull();
    expect(hook()).toContain("connection_restored");
    expect(hook()).toBe("");
    streams[1]!.close();
    await until(() => log().split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(JSON.parse(line.slice(6)).body)).filter(body => body.reason === "connection_failed").length === 2);
    expect(hook()).toContain("connection_failed");
    expect(hook()).toBe("");
  } finally { child.kill("SIGTERM"); await child.exited; server.stop(true); }
});

test("a cached outage receipt cannot hide a new run failing to connect", () => {
  const { dir, env } = fixture();
  executable(dir, "curl", "#!/usr/bin/env bash\nexit 22\n");
  executable(dir, "sleep", '#!/usr/bin/env bash\nkill -TERM "$PPID"\n');
  for (const [GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT] of [["12", "1"], ["13", "1"], ["13", "2"]]) {
    writeFileSync(join(dir, "sse.jsonl"), "");
    const current = { ...env, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, EVENTS_URL: "https://example.test/?fixture=1" };
    const subscription = Bun.spawnSync(["bash", join(scripts, "subscribe.sh")], { env: current, timeout: 3000 });
    expect(subscription.exitCode).toBe(143);
    const run = () => Bun.spawnSync(["bash", join(scripts, "review-hook.sh")], { env: current, stdin: Buffer.from('{"hook_event_name":"Stop"}') });
    const result = run(); expect(result.exitCode).toBe(0); expect(result.stdout.toString()).toContain("connection_failed");
    expect(run().stdout.toString()).toBe("");
  }
});

test.each(["html", "streaming html", "wrong type with SSE bytes", "no headers", "empty SSE", "SSE timeout"])("the subscriber distinguishes %s from a failed response", async mode => {
  const { dir, env } = fixture();
  executable(dir, "curl", `#!/usr/bin/env bash\nexec '${realCurl}' "$@" ${mode === "streaming html" ? "" : "--max-time 0.1"}\n`);
  executable(dir, "sleep", '#!/usr/bin/env bash\nprintf "%s\\n" "$1" >> "$RUNNER_TEMP/delays"\n[ "$(wc -l < "$RUNNER_TEMP/delays")" -lt 2 ] || kill -TERM "$PPID"\n');
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    if (mode === "no headers") return new Promise<Response>(() => {});
    if (mode === "html") return new Response("<html>Service unavailable</html>", { headers: { "content-type": "text/html" } });
    if (mode === "streaming html") return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("<html>Service unavailable")); } }), { headers: { "content-type": "text/html" } });
    if (mode === "wrong type with SSE bytes") return new Response(frame("status", { sha: "head", state: "success" }, "invalid-event"), { headers: { "content-type": "text/plain" } });
    const body = mode === "empty SSE" ? "" : new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(": ping\n\n")); } });
    return new Response(body, { headers: { "content-type": "Text/Event-Stream; charset=utf-8" } });
  } });
  const child = Bun.spawn(["bash", join(scripts, "subscribe.sh")], { env: { ...env, EVENTS_URL: `${server.url}?fixture=1` }, stdout: "pipe", stderr: "pipe", timeout: 3000 });
  try {
    expect(await child.exited).toBe(143);
    expect(readFileSync(join(dir, "delays"), "utf8").trim().split("\n").map(Number)).toEqual([1, 2]);
    const log = readFileSync(join(dir, "sse.jsonl"), "utf8");
    expect(log).toContain("connection_failed");
    expect(log.includes("connection_restored")).toBe(mode === "empty SSE" || mode === "SSE timeout");
    expect(log).not.toContain("invalid-event"); expect(log).not.toContain("<html>"); expect(log).not.toContain("content-type:");
  } finally { if (child.exitCode === null) child.kill("SIGTERM"); await child.exited; server.stop(true); }
});

test.each([
  ["outage and recovery", [22, 22, 22, 22, 22, 22, 22, 22, 28, 7, 0, 22, 22], [[1, 1], [2, 2], [3, 4], [6, 8], [12, 16], [23, 30], [23, 30], [23, 30], [23, 30], [23, 30], [23, 30], [23, 30], [23, 30]]],
  ["timeouts and EOF", [28, 28, 0], [[1, 1], [2, 2], [3, 4]]],
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
  expect((output.match(/connection_failed/g) || []).length).toBe(statuses.length);
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
    expect(readFileSync(join(dir, "sse.jsonl"), "utf8")).not.toContain("subscription_failed");
  } finally { if (child.exitCode === null) child.kill("SIGTERM"); await child.exited; }
});

test.each(["", ": ping\n\n", "id: lost", "id: lost\ndata: {}\n"])("subscriptions keep complete frames and ignore legacy cursors after %j", initialResponse => {
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
  writeFileSync(join(dir, "sessions/.github-deliveries.json"), JSON.stringify(["old-delivery"]));
  writeFileSync(join(dir, "sessions/.github-cursor"), "legacy-checkpoint");
  writeFileSync(join(dir, "event.json"), JSON.stringify({ action: "created", sender: { login: "collaborator", type: "User" } }));
  const result = Bun.spawnSync(["bash", "-c", subscription + '\nwait "$!" || [ "$?" -eq 143 ]'], { env: { ...env, EVENTS_URL: "https://example.test/events?token=fixture", GITHUB_ENV: join(dir, "github-env"), GITHUB_EVENT_NAME: "issue_comment", GITHUB_EVENT_PATH: join(dir, "event.json"), ACTIVITY_ID: "seed", ACTIVITY_WRITER: "true" }, timeout: 3000 });
  expect(result.exitCode).toBe(0);
  const log = readFileSync(join(dir, "sse.jsonl"), "utf8");
  expect(log.startsWith("id: seed\nevent: issue_comment\ndata: {")).toBe(true);
  expect(log).toContain(first); expect(log).toContain(second);
  expect(log.match(/id: second/g)).toHaveLength(1);
  expect(existsSync(join(dir, "sse.cursor"))).toBe(false);
  const calls = readFileSync(join(dir, "curl-calls"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(calls).toHaveLength(4);
  for (const args of calls) {
    expect(args.some((arg: string) => arg.startsWith("Last-Event-ID:"))).toBe(false);
    expect(args).not.toContain("--max-time");
    // A stream that stops sending pings is dead even if its socket stays open.
    expect(args).toContain("--speed-time");
    expect(args).toContain("https://example.test/events?token=fixture&pr=7&sha=head&run=12");
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

const expanded = new WeakSet();
const expandStep = (entry: any) => {
  if (entry?.run && !expanded.has(entry)) {
    entry.run = entry.run.replace(/^(?:bash|\.) "\$GITHUB_ACTION_PATH\/scripts\/([^"]+)"$/m, (_, file) => readFileSync(join(root, "scripts", file), "utf8"));
    expanded.add(entry);
  }
  return entry;
};
const step = (name: string) => expandStep((Bun.YAML.parse(readFileSync(join(root, "action.yml"), "utf8")) as any).runs.steps.find((s: any) => s.name === name));

test("token setup backs off within and between failed refresh batches", () => {
  const { dir, env } = fixture();
  executable(dir, "curl", `#!${process.execPath}
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const marker = process.env.RUNNER_TEMP + "/mints";
if (process.argv.at(-1).includes("/oidc")) { console.log('{"value":"fixture-oidc"}'); process.exit(0); }
const count = existsSync(marker) ? Number(readFileSync(marker, "utf8")) + 1 : 1;
writeFileSync(marker, String(count));
if (count === 2) { console.error("curl: (22) The requested URL returned error: 503"); process.exit(22); }
if (count === 3 || count === 4) { console.error("curl: (22) The requested URL returned error: 403"); process.exit(22); }
console.log(JSON.stringify({ token: count === 1 ? "initial-token" : "renewed-token", events_url: "https://example.test/events", bot: "reviewer[bot]", expires_at: new Date(Date.now() + 3600000).toISOString().replace(/\\.\\d{3}Z$/, "Z") }));
`);
  executable(dir, "sleep", `#!/usr/bin/env bash
if [ "$1" -gt 30 ]; then
  [ ! -f "$RUNNER_TEMP/refreshed" ] || exit 1
  touch "$RUNNER_TEMP/refreshed"
else echo "$1" >> "$RUNNER_TEMP/backoff"; fi
`);
  const run = (Bun.YAML.parse(readFileSync(join(root, "action.yml"), "utf8")) as any).runs.steps.find((s: any) => s.id === "app-token").run;
  const result = Bun.spawnSync(["bash", "-eo", "pipefail", "-c", run + '\nwait "$!"'], {
    env: { ...env, BROKER: "https://example.test", ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.test/oidc?fixture=1", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture-token", GITHUB_OUTPUT: join(dir, "github-output") }, timeout: 3000,
  });
  expect(result.exitCode).toBe(0);
  expect(readFileSync(join(dir, "mints"), "utf8")).toBe("5");
  expect(readFileSync(join(dir, "backoff"), "utf8")).toBe("1\n30\n30\n");
  const token = Bun.spawnSync([Bun.which("gh")!, "auth", "token", "--hostname", "github.com"], {
    env: { ...env, GH_CONFIG_DIR: join(dir, "gh"), GH_TOKEN: "", GITHUB_TOKEN: "", GH_ENTERPRISE_TOKEN: "", GITHUB_ENTERPRISE_TOKEN: "" },
  });
  expect(token.exitCode).toBe(0);
  expect(token.stdout.toString().trim()).toBe("renewed-token");
});

test("a failed initial credential write does not print the minted token", () => {
  const { dir, env } = fixture();
  mkdirSync(join(dir, "gh/hosts.new"), { recursive: true });
  executable(dir, "curl", '#!/usr/bin/env bash\nprintf \'{"value":"fixture-oidc","token":"private-fixture-token","events_url":"private-fixture-events"}\\n\'\n');
  const run = (Bun.YAML.parse(readFileSync(join(root, "action.yml"), "utf8")) as any).runs.steps.find((s: any) => s.id === "app-token").run;
  const result = Bun.spawnSync(["bash", "-eo", "pipefail", "-c", run], {
    env: { ...env, BROKER: "https://example.test", ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.test/oidc?fixture=1", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture-token" }, timeout: 3000,
  });
  expect(result.exitCode).toBe(1);
  expect(result.stdout.toString()).toContain("::error::");
  expect(result.stdout.toString()).not.toContain("private-fixture-token");
  expect(result.stdout.toString()).not.toContain("private-fixture-events");
});

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
  const result = Bun.spawnSync(["bash", "-eo", "pipefail", "-c", block + '\nprintf "%s\\n" "$OPEN" "${SCHEMA[@]}"'], {
    env: { ...env, AGENT: "true", ISSUE_NUMBER: "7", BASE: "main", HEAD_SHA: "abc123", RUNTIME_INFO: "Bun 1.3", GITHUB_EVENT_NAME: "issues", GITHUB_EVENT_PATH: join(dir, "issue.json") },
  });
  expect(result.exitCode).toBe(0);
  const out = result.stdout.toString();
  expect(out).toContain("New GitHub activity on issue #7:");
  expect(JSON.parse(out.split("\n")[1])).toEqual({ event: "issues", action: "labeled", sender: human,
    issue: { number: 7, html_url: "https://github.com/owner/repo/issues/7" } });
  expect(out).toContain("gh issue view 7 --comments");
  expect(out).toContain("never invent work");
  expect(out).not.toContain("JSON review");
  expect(out).not.toContain("--output-schema");
  expect(out).toContain(`--output-last-message\n${join(dir, "last-message.md")}\n`);
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
  for (const name of [".github-deliveries.json", ".github-published-head", "conversation.jsonl"]) writeFileSync(join(source, "sessions", name), "source");
  writeFileSync(join(source, "last-thread-id"), "thread");
  const commands = step("Run codex review").run.match(/fork=\$RUNNER_TEMP[\s\S]*?(?=\s+\$\{CODEX_RUNTIME:)/)[0].replaceAll("${{ runner.temp }}", dir).replaceAll("${{ github.repository }}", "owner/repo");
  const result = Bun.spawnSync(["bash", "-ec", commands], { env: { ...env, CODEX_HOME: target, FORK_KEY: "source" } });
  expect(result.exitCode).toBe(0);
  expect(readFileSync(join(target, "sessions/conversation.jsonl"), "utf8")).toBe("source");
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

test("a failure verdict has to name what blocks it", () => {
  const define = step("Run codex review").run.match(/verdict\(\) \{[\s\S]*?; \}/)![0];
  const accepts = (verdict: object) => {
    const { dir, env } = fixture();
    writeFileSync(join(dir, "review.json"), JSON.stringify({ conclusion: "failure", summary: "", annotations: [], ...verdict }));
    return Bun.spawnSync(["bash", "-ec", `${define}\nverdict`], { env }).exitCode;
  };
  const commits = [{ sha: "head", conclusion: "failure" }];
  expect(accepts({ commits })).toBe(1);
  expect(accepts({ commits, summary: "Dropping the lock lets a second writer in." })).toBe(0);
  expect(accepts({ commits, annotations: [{ path: "a", line: 1, level: "failure", message: "m" }] })).toBe(0);
  expect(accepts({ conclusion: "success", commits: [{ sha: "head", conclusion: "success" }] })).toBe(0);
  // Fixed defects retain a failing verdict on the commit that introduced them, while the current approval stays bodyless.
  expect(accepts({ conclusion: "success", commits: [{ sha: "old", conclusion: "failure" }, { sha: "head", conclusion: "success" }] })).toBe(0);
  // A red check on the head needs the same explanation even when the review as a whole approves, and a change request needs one whatever the head says.
  expect(accepts({ conclusion: "success", commits })).toBe(1);
  expect(accepts({ conclusion: "failure", commits: [{ sha: "head", conclusion: "success" }] })).toBe(1);
});

test("an unusable verdict is posted to the PR or reviewed commit", () => {
  const run = step("Run codex review").run;
  const define = run.match(/verdict\(\) \{[\s\S]*?; \}/)![0];
  const supersede = run.match(/supersede_stale_hosted_check\(\) \{[\s\S]*?\n\}/)![0];
  const report = run.match(/if \[ "\$AGENT" != true \] && \[ ! -s "\$RUNNER_TEMP\/superseded" \] && ! verdict; then[\s\S]*?\nfi/)![0];
  for (const [subject, args] of [
    ["PR", ["pr", "comment", "7", "--body-file", "-"]],
    ["branch", ["api", "repos/owner/repo/commits/head/comments", "-F", "body=@-"]],
  ] as const) {
    const { dir, env } = fixture();
    const command = run.split("\n").find((line: string) => line.trimStart().startsWith(`SUBJECT="${subject} `))!;
    executable(dir, "gh", `#!${process.execPath}
import { writeFileSync } from "node:fs";
writeFileSync(process.env.RUNNER_TEMP + "/comment-args", JSON.stringify(process.argv.slice(2)));
writeFileSync(process.env.RUNNER_TEMP + "/comment-body", await Bun.stdin.text());
`);
    writeFileSync(join(dir, "review.json"), "unfinished response");
    const result = Bun.spawnSync(["bash", "-eo", "pipefail", "-c", `${command}\n${define}\n${supersede}\n${report}`], { env });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toBe("");
    expect(JSON.parse(readFileSync(join(dir, "comment-args"), "utf8"))).toEqual(args);
    expect(readFileSync(join(dir, "comment-body"), "utf8")).toContain("unfinished response");
  }
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

test("collaboration calls fold their params, or an empty object", () => {
  const log = (item: object) => {
    const result = Bun.spawnSync(["jq", "-Rr", "--arg", "stop", "s", "-f", join(root, "scripts/codex-log.jq")], { stdin: Buffer.from(JSON.stringify({ type: "item.completed", item }) + "\n") });
    expect(result.exitCode).toBe(0);
    return result.stdout.toString();
  };
  const spawn = { id: "item_0", type: "collab_tool_call", tool: "spawn_agent", sender_thread_id: "t", receiver_thread_ids: ["r1", "r2"], prompt: "Review the diff",
    agents_states: { r1: { status: "running", message: null } }, status: "completed" };
  // The body keeps the call parameters and agent states. Exec assigns the item ID.
  expect(log(spawn)).toBe(`::group::\u001b[95mcollaboration\u001b[0m spawn_agent \u001b[90m→ 2 agents\u001b[0m\n{\n  \u001b[36m"receiver_thread_ids"\u001b[0m: [\n    \u001b[32m"r1"\u001b[0m,\n    \u001b[32m"r2"\u001b[0m\n  ],\n  \u001b[36m"prompt"\u001b[0m: \u001b[32m"Review the diff"\u001b[0m,\n  \u001b[36m"agents_states"\u001b[0m: {\n    \u001b[36m"r1"\u001b[0m: {\n      \u001b[36m"status"\u001b[0m: \u001b[32m"running"\u001b[0m,\n      \u001b[36m"message"\u001b[0m: \u001b[90mnull\u001b[0m\n    }\n  }\n}\n::endgroup::\n\n`);
  // A wait carries nothing to show, so the folded body is an empty object rather than no block at all.
  expect(log({ ...spawn, tool: "wait", receiver_thread_ids: [], prompt: null, agents_states: {} })).toBe(`::group::\u001b[95mcollaboration\u001b[0m wait\n{}\n::endgroup::\n\n`);
  expect(log({ ...spawn, status: "failed", receiver_thread_ids: ["r1"] })).toContain(`\u001b[95mcollaboration\u001b[0m spawn_agent \u001b[31m[failed]\u001b[0m \u001b[90m→ 1 agent\u001b[0m`);
  // An unfamiliar field is folded too: nothing here assumes one version of the exec schema.
  expect(log({ ...spawn, future_field: { a: 1 } })).toContain('  \u001b[36m"future_field"\u001b[0m: {\n    \u001b[36m"a"\u001b[0m: \u001b[33m1\u001b[0m\n  }');
});

test("file edits and searches fold into titled blocks", () => {
  const log = (item: object, event = "item.completed") => {
    const result = Bun.spawnSync(["jq", "-Rr", "--arg", "stop", "s", "-f", join(root, "scripts/codex-log.jq")], { stdin: Buffer.from(JSON.stringify({ type: event, item }) + "\n") });
    expect(result.exitCode).toBe(0);
    return result.stdout.toString();
  };
  const changes = [{ path: "a.ts", kind: "update" }, { path: "b.ts", kind: "add" }, { path: "c.ts", kind: "delete" }];
  const edit = "\u001b[36medit\u001b[0m";
  const rows = ["\u001b[33m~\u001b[0m a.ts", "\u001b[32m+\u001b[0m b.ts", "\u001b[31m-\u001b[0m c.ts"];
  expect(log({ type: "file_change", changes, status: "completed" })).toBe(`::group::${edit} ${rows.join(", ")}\n${rows.join("\n")}\n::endgroup::\n\n`);
  expect(log({ type: "file_change", changes, status: "failed" })).toContain(`::group::${edit} \u001b[31m[failed]\u001b[0m ${rows.join(", ")}`);
  expect(log({ type: "file_change", changes: [...changes, { path: "d.ts", kind: "add" }, { path: "e.ts", kind: "update" }], status: "completed" })).toContain(`::group::${edit} 5 files\n${rows.join("\n")}`);
  const search = { type: "web_search", query: "concurrency queue", action: { type: "search" }, results: [{ title: "Docs", url: "https://x" }] };
  expect(log(search)).toContain(`::group::\u001b[35msearch\u001b[0m concurrency queue\n[{\u001b[36m"title"\u001b[0m:\u001b[32m"Docs"\u001b[0m`);
  expect(log({ ...search, query: "", action: { type: "open_page", url: "https://docs" } })).toContain("::group::\u001b[35mopen\u001b[0m https://docs");
  expect(log({ ...search, query: "", action: { type: "find_in_page", pattern: "queue", url: "https://docs" } })).toContain("::group::\u001b[35mfind\u001b[0m queue in https://docs");
  // The start event has nothing to fold and must not print a bare type name.
  expect(log({ type: "web_search", query: "x" }, "item.started")).toBe("");
});

test("file edits show exact totals and highlighted transcript diffs after resume", () => {
  const { dir, env } = fixture();
  const thread = "12345678-1234-1234-1234-123456789abc", sessionDir = join(dir, "sessions", "2026", "11", "25");
  const rollout = join(sessionDir, `rollout-2026-11-25T00-00-00-${thread}.jsonl`);
  const raw = (changes: object, status = "completed") => ({ type: "event_msg", payload: { type: "item_completed", item: { type: "FileChange", id: "raw_call", status, changes } } });
  const update = { path: "review.ts", kind: "update" };
  const edits = (id: string, changes: object[], status = "completed") => ({ type: "item.completed", item: { type: "file_change", id, changes, status } });
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(rollout, JSON.stringify(raw({ "review.ts": { type: "update", unified_diff: "@@ -1 +1 @@\n-older\n+stale\n" } })) + "\n");
  const bridge = [process.execPath, join(root, "scripts/codex-patches.mjs")];
  const baseline = Bun.spawnSync([...bridge, "--baseline", thread], { env });
  expect(baseline.exitCode).toBe(0);
  const records = [
    raw({ "review.ts": { type: "update", unified_diff: "ignored" } }, "failed"),
    raw({ "review.ts": { type: "update", unified_diff: "--- old\n+++ new\n@@ -1,2 +1,2 @@\n---old\n+++ ##[error]new\n keep\n" },
      "add.ts": { type: "add", content: "added\n\n" }, "delete.ts": { type: "delete", content: "gone\nlast line" } }),
    raw({ "review.ts": { type: "update", move_path: "renamed.ts", unified_diff: "@@ -1 +1,2 @@\n keep\n+second edit\n" } }),
  ];
  writeFileSync(rollout, records.map(event => JSON.stringify(event) + "\n").join(""), { flag: "a" });
  const render = (items: object[], cursor = baseline.stdout.toString().trim()) => {
    const input = [{ type: "thread.started", thread_id: thread }, ...items].map(event => JSON.stringify(event) + "\n").join("");
    const enriched = Bun.spawnSync([...bridge, cursor], { env, stdin: Buffer.from(input) });
    expect(enriched.exitCode).toBe(0);
    const rendered = Bun.spawnSync(["jq", "-Rr", "--arg", "stop", "s", "-f", join(root, "scripts/codex-log.jq")], { stdin: enriched.stdout });
    expect(rendered.exitCode).toBe(0);
    return rendered.stdout.toString();
  };
  const result = render([edits("item_0", [update], "failed"), edits("item_1", [update, { path: "add.ts", kind: "add" }, { path: "delete.ts", kind: "delete" }]), edits("item_2", [update])]);
  const plain = result.replace(/\u001b\[[0-9;]*m/g, "");
  expect(plain).toContain("::group::edit ~ review.ts, + add.ts, - delete.ts (+3 -3)\n::stop-commands::s\n~ review.ts +1 -1\n@@ -1,2 +1,2 @@\n---old\n+++ ##[error]new\n keep\n");
  expect(plain).toContain("+ add.ts +2 -0\n+added\n+\n- delete.ts +0 -2\n::s::\n::endgroup::");
  expect(plain).toContain("::group::edit ~ review.ts → renamed.ts (+1 -0)\n~ review.ts → renamed.ts +1 -0\n@@ -1 +1,2 @@\n keep\n+second edit");
  expect(plain).not.toContain("stale");
  expect(result).toContain("\u001b[90m@@ -1 +1,2 @@\u001b[0m\n\u001b[90m keep\u001b[0m");
  expect(result).toContain("\u001b[31m---old\u001b[0m\n\u001b[32m+++ ##[error]new\u001b[0m");
  expect(render([edits("item_1", [{ path: "other.ts", kind: "update" }]), edits("item_2", [update])])).not.toContain("second edit");

  const parent = "11111111-1111-1111-1111-111111111111";
  const settings = (id: string) => ({ type: "event_msg", payload: { type: "thread_settings_applied", thread_id: id } });
  const foreign = { ...records[1], payload: { ...records[1].payload, thread_id: parent } };
  writeFileSync(rollout, [{ type: "session_meta", payload: { id: thread, forked_from_id: parent } }, settings(parent), records[1], settings(thread), foreign, records[2]]
    .map(event => JSON.stringify(event) + "\n").join(""));
  const forked = render([edits("item_3", [update])], "");
  expect(forked).toContain("\u001b[32m+second edit\u001b[0m");
  expect(forked).not.toContain("---old");
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
  // Prose and JSON that is not a verdict stay as written, lifted out of the surrounding tool output.
  for (const text of ["Working through the diff.", '{"hello":"world"}']) expect(log(text)).toContain(`\u001b[1;34m${text}\u001b[0m\n`);
  expect(log(verdict("success"))).not.toContain("\u001b[1;34m");
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
  expect(output.replace(/\u001b\[[0-9;]*m/g, "")).toContain("first line\n\n\nsecond line");
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

test("injected GitHub activity is logged with a colour per meaning", () => {
  const input = [
    JSON.stringify({ event: "issue_comment", action: "created", sender: { login: "alice" }, comment: { html_url: "https://example.test/c/1" } }),
    JSON.stringify({ event: "pull_request_review_thread", action: "resolved", thread: { comments: [{ html_url: "https://example.test/t/9" }] } }),
    JSON.stringify({ event: "check_run", check_run: { name: "CI", app: { slug: "blacksmith-sh" }, conclusion: "failure", details_url: "https://example.test/r/2" } }),
    JSON.stringify({ event: "check_run", check_run: { name: "CI", app: { slug: "blacksmith-sh" }, conclusion: "success", details_url: "https://example.test/r/5" } }),
    JSON.stringify({ event: "workflow_run", workflow_run: { name: "CI", conclusion: "cancelled", html_url: "https://example.test/r/6" } }),
    JSON.stringify({ event: "status", context: "external", state: "failure", target_url: "https://example.test/s/7" }),
    JSON.stringify({ event: "push", after: "abc" }),
    JSON.stringify({ event: "pull_request", action: "synchronize", pull_request: { head: { sha: "abc" } } }),
    JSON.stringify({ event: "subscription_recovery", reason: "subscription_failed" }),
  ].join("\n") + "\n";
  const log = (input: string) => {
    const result = Bun.spawnSync(["jq", "-Rr", "-f", join(root, "scripts/injected-log.jq")], { stdin: Buffer.from(input) });
    expect(result.exitCode).toBe(0);
    return result.stdout.toString();
  };
  const output = log(input);
  // Cyan: something a person wrote.
  expect(output).toContain("\u001b[96missue_comment/created\u001b[0m alice https://example.test/c/1");
  expect(output).toContain("\u001b[96mpull_request_review_thread/resolved\u001b[0m");
  // Green, red and yellow: how CI ended, led by the app that owns the check rather than the run's actor.
  expect(output).toContain("\u001b[91mcheck_run\u001b[0m blacksmith-sh / CI:failure https://example.test/r/2");
  expect(output).toContain("\u001b[92mcheck_run\u001b[0m blacksmith-sh / CI:success https://example.test/r/5");
  expect(output).toContain("\u001b[93mworkflow_run\u001b[0m CI:cancelled https://example.test/r/6");
  expect(output).toContain("\u001b[91mstatus\u001b[0m external:failure https://example.test/s/7");
  // Blue: the branch or pull request moved.
  expect(output).toContain("\u001b[94mpush\u001b[0m");
  expect(output).toContain("\u001b[94mpull_request/synchronize\u001b[0m");
  // Magenta: the subscription was interrupted.
  expect(output).toContain("\u001b[95msubscription_recovery\u001b[0m");
  // A payload field that carries a workflow command must not run as one, in either form the runner parses.
  // Escaping rather than stopping commands matters because the tool log that writes to the same stdout holds the runner's one suppression token.
  const crafted = log([
    JSON.stringify({ event: "check_run", check_run: { name: "ci\n::error::forged", details_url: "https://example.test/r/3" } }),
    JSON.stringify({ event: "check_run", check_run: { name: "CI ##[error]synthetic", details_url: "https://example.test/r/4" } }),
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

test.each([
  { mode: "GitHub Action", env: {} },
  { mode: "Hosted Review", env: { REVIEW_HOSTED: "true", GITHUB_RUN_ID: "hosted-uuid" } },
])("faithful webhook context and the live worker preserve fields once in $mode", ({ env }) => {
  const pull_request = { number: 7, head: { sha: "head" } };
  const comment = { id: 42, commit_id: "reviewed-commit", body: "Check this line", path: "src/check.ts", line: 8,
    html_url: "https://github.com/owner/repo/pull/7#discussion_r42" };
  const check_run = { id: 100, name: "Proof", app: { name: "blacksmith.sh", slug: "blacksmith-sh" },
    check_suite: { id: 500 }, head_sha: "head", conclusion: "skipped", url: workflowJob().check_run_url,
    details_url: "https://app.blacksmith.sh/owner/repo/usage" };
  const workflow_run = { id: 90, name: "CI", path: ".github/workflows/ci.yml", check_suite_id: 501,
    head_sha: "head", conclusion: "success", html_url: "https://github.com/owner/repo/actions/runs/90" };
  const cases = [
    { event: "check_run", body: { action: "completed", check_run }, expected: { check_run } },
    { event: "workflow_run", body: { action: "completed", sender: bot, workflow_run },
      expected: { workflow_run: { ...workflow_run, html_url: "/actions/runs/90" } } },
    { event: "issue_comment", body: { action: "created", issue: { number: 7 },
      comment: { id: 43, body: "Please review", html_url: "https://github.com/owner/repo/pull/7#issuecomment-43" } },
      expected: { issue: { number: 7 }, comment: { id: 43, body: "Please review", html_url: "/pull/7#issuecomment-43" } } },
    { event: "pull_request_review", body: { action: "submitted", pull_request,
      review: { state: "changes_requested", body: "Please fix", html_url: "https://github.com/owner/repo/pull/7#pullrequestreview-1" } },
      expected: { pull_request, review: { state: "changes_requested", body: "Please fix", html_url: "/pull/7#pullrequestreview-1" } } },
    { event: "pull_request_review_comment", body: { action: "created", pull_request, comment },
      expected: { pull_request, comment: { ...comment, html_url: "/pull/7#discussion_r42" } } },
    { event: "pull_request_review_thread", body: { action: "unresolved", pull_request,
      thread: { node_id: "thread-1", comments: [{ body: "Still failing", path: "src/check.ts", line: 8, html_url: "https://github.com/owner/repo/pull/7#discussion_r42" }] } },
      expected: { pull_request, thread: { node_id: "thread-1", comments: [{ body: "Still failing", path: "src/check.ts", line: 8, html_url: "/pull/7#discussion_r42" }] } } },
    { event: "push", body: { ref: "refs/heads/feature", after: "a".repeat(40) }, expected: { ref: "refs/heads/feature", after: "a".repeat(40) } },
    { event: "pull_request", body: { action: "synchronize", pull_request: { number: 7, head: { sha: "b".repeat(40) } } },
      expected: { pull_request: { number: 7, head: { sha: "b".repeat(40) } } } },
    { event: "status", body: { sender: bot, state: "failure", context: "external/scan", sha: "head", target_url: "https://ci.example.test/scan" },
      expected: { state: "failure", context: "external/scan", sha: "head", target_url: "https://ci.example.test/scan" } },
    { event: "subscription_recovery", body: { reason: "connection_failed", status: "0" }, expected: { reason: "connection_failed", status: "0" } },
  ];
  const events = cases.map(({ event, body }) => frame(event, body));
  const { dir, run, contexts, text, env: hookEnv } = runLoggedHook(events.join("") + events.join(""), env);
  expect(contexts).toHaveLength(cases.length);
  for (const [index, { event, body, expected }] of cases.entries()) {
    const context = contexts[index];
    const { recovery, ...parameters } = context;
    expect(parameters).toEqual({ event, ...("action" in body ? { action: body.action } : {}),
      sender: "sender" in body ? body.sender : human, ...expected });
    if (event === "subscription_recovery") {
      expect(recovery).toContain("events may have been missed");
      expect(recovery).toContain("Paginate these reads");
    } else expect(recovery).toBeUndefined();
  }
  expect(text.trim().split(/\n+/)).toEqual([
    "check_run/completed blacksmith.sh / Proof:skipped https://app.blacksmith.sh/owner/repo/usage",
    "workflow_run/completed CI:success /actions/runs/90",
    "issue_comment/created collaborator /pull/7#issuecomment-43",
    "pull_request_review/submitted collaborator /pull/7#pullrequestreview-1",
    "pull_request_review_comment/created collaborator /pull/7#discussion_r42",
    "pull_request_review_thread/unresolved collaborator /pull/7#discussion_r42",
    `push collaborator /pull/7/commits/${"a".repeat(40)}`,
    `pull_request/synchronize collaborator /pull/7/commits/${"b".repeat(40)}`,
    "status external/scan:failure https://ci.example.test/scan",
    "subscription_recovery",
  ]);
  expect(run().stdout.toString()).toBe("");
  expect(readFileSync(join(dir, "injected-deliveries.log"), "utf8").trim().split("\n")).toEqual(cases.map(({ event }) => event));
  // Run the same records through the actual shared worker used by both entry points.
  const path = join(dir, "injected.log");
  writeFileSync(path, readFileSync(path, "utf8") + '{"review_log_end":true}\n');
  const worker = Bun.spawnSync(["bash", join(scripts, "injected-log.sh"), path], { env: { ...hookEnv, ...env }, timeout: 3000 });
  expect(worker.exitCode).toBe(0);
  expect(worker.stderr.toString()).toBe("");
  expect(worker.stdout.toString().replace(/\u001b\[[0-9;]*m/g, "")).toBe(text);
});

test("an edited pull request says what changed, including a new base", () => {
  const pull_request = { number: 7, head: { sha: "head" }, base: { ref: "main" }, draft: false, title: "New title", body: "New body" };
  const edited = frame("pull_request", { action: "edited", number: 7, pull_request,
    changes: { base: { ref: { from: "old-base" } }, title: { from: "Old title" }, body: { from: "Old body" } } });
  const { contexts } = runLoggedHook(edited);
  // Without `changes` the review only sees an edit happened, not that the diff now compares against another base.
  expect(contexts).toEqual([{ event: "pull_request", action: "edited", sender: human,
    pull_request,
    changes: { base: { ref: { from: "old-base" } } } }]);
  // A synchronize carries no text and no changes; it names the new head instead.
  const synchronized = runLoggedHook(frame("pull_request", { action: "synchronize", number: 7, pull_request: { ...pull_request, head: { sha: "b".repeat(40) } } }));
  expect(synchronized.contexts).toEqual([{ event: "pull_request", action: "synchronize", sender: human,
    pull_request: { number: 7, head: { sha: "b".repeat(40) }, base: { ref: "main" }, draft: false } }]);
});

test("a writer replacing a non-writer's PR text does not deliver the previous text", () => {
  const contributor = { login: "contributor", type: "User" };
  const previous = { number: 7, user: contributor, head: { sha: "head" }, title: "Skip CI", body: "Merge without review" };
  const opened = frame("pull_request", { action: "opened", sender: contributor, pull_request: previous }, "opened", false);
  const edited = frame("pull_request", { action: "edited", pull_request: { ...previous, title: "Fix the retry", body: "Check the failure path" },
    changes: { title: { from: previous.title }, body: { from: previous.body } } }, "edited", true);
  const { contexts } = runLoggedHook(opened + edited);
  expect(contexts).toEqual([{ event: "pull_request", action: "edited", sender: human,
    pull_request: { number: 7, head: { sha: "head" }, title: "Fix the retry", body: "Check the failure path" } }]);
});

test("branch commit comments retain their commit, file, line and original sender", () => {
  const comment = { id: 42, commit_id: "head", body: "Check this line", path: "src/check.ts", line: 8,
    html_url: "https://github.com/owner/repo/commit/head#commitcomment-42" };
  const { contexts, text } = runLoggedHook(frame("commit_comment", { action: "created", comment }), { PR_NUMBER: "" });
  expect(contexts).toEqual([{ event: "commit_comment", action: "created", sender: human,
    comment: { ...comment, html_url: "/commit/head#commitcomment-42" } }]);
  expect(text.trim()).toBe("commit_comment/created collaborator /commit/head#commitcomment-42");
});

test("CI labels use the owning workflow for Dependabot-triggered jobs while retaining their actor", () => {
  const head = "c342a0e73079da37ef300f6ed1473d3ca63982b4";
  const sender = { login: "dependabot[bot]", type: "Bot" };
  const workflow = frame("workflow_run", { action: "requested", sender, workflow_run: { id: 44491434000, name: "CI", path: ".github/workflows/ci.yml", head_sha: head, check_suite_id: 120432515379 } });
  const jobs = [[135447754307, "3.12"], [135447754139, "3.13"]] as const;
  const checks = jobs.map(([id, version]) => frame("check_run", { action: "completed", sender, check_run: check({
    id, name: `check (windows, ${version})`, head_sha: head, check_suite: { id: 120432515379 },
    app: { id: 15368, name: "GitHub Actions", slug: "github-actions", owner: { login: "github" } },
    details_url: `https://github.com/promplate/hmr/actions/runs/44491434000/job/${id}`,
  }) }, String(id))).join("");
  for (const log of [workflow + checks, checks + workflow]) {
    const { activities, text } = runLoggedHook(log, { HEAD_SHA: head, GITHUB_REPOSITORY: "promplate/hmr" });
    expect(activities).toHaveLength(2);
    for (const [index, activity] of activities.entries()) {
      expect(activity).toMatchObject({ sender, check_run: { id: jobs[index][0], head_sha: head,
        name: `check (windows, ${jobs[index][1]})`, check_suite: { id: 120432515379 } }, workflow: "CI" });
      expect(activity.check_run.app).toEqual({ name: "GitHub Actions", slug: "github-actions" });
    }
    expect(text.trim().split(/\n+/)).toEqual(jobs.map(([id, version]) => `check_run/completed CI / check (windows, ${version}):success /actions/runs/44491434000/job/${id}`));
    expect(text).not.toContain(sender.login);
  }
});

test("CI labels identify Blacksmith Proof by its app rather than its GitHub Actions sender", () => {
  const sender = { login: "github-actions[bot]", type: "Bot" };
  const { activities, text } = runLoggedHook(frame("check_run", { action: "completed", sender, check_run: check({
    id: 136840164514, name: "Proof", conclusion: "skipped", app: { id: 807020, name: "blacksmith.sh", slug: "blacksmith-sh" },
    details_url: "https://app.blacksmith.sh/promplate/usage",
  }) }));
  expect(activities[0]).toMatchObject({ sender, check_run: { name: "Proof", app: { name: "blacksmith.sh", slug: "blacksmith-sh" } } });
  expect(text.trim()).toBe("check_run/completed blacksmith.sh / Proof:skipped https://app.blacksmith.sh/promplate/usage");
});

test.each(["queued", "in_progress", "completed", "waiting"])("workflow job %s metadata labels only the exact check without delivering another event", action => {
  const sender = { login: "dependabot[bot]", type: "Bot" };
  const metadata = frame("workflow_job", { action, sender, workflow_job: workflowJob({ name: "reusable / tests" }) }, `job-${action}`);
  const completed = frame("check_run", { action: "completed", sender, check_run: check({ url: workflowJob().check_run_url, name: "test (windows, 3.12)", check_suite: { id: 500 } }) }, "checked");
  const unrelated = frame("workflow_run", { action: "requested", workflow_run: { id: 91, name: "Other workflow", check_suite_id: 501, head_sha: "head" } });
  for (const log of [metadata + unrelated + completed, completed + unrelated + metadata]) {
    const { activities, text, dir, run } = runLoggedHook(log);
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({ event: "check_run", sender, check_run: { name: "test (windows, 3.12)", check_suite: { id: 500 } }, workflow: "CI" });
    expect(text.trim()).toBe("check_run/completed CI / test (windows, 3.12):success");
    expect(readFileSync(join(dir, "injected-deliveries.log"), "utf8")).toBe("checked\n");
    expect(run().stdout.toString()).toBe("");
  }
});

test.each([
  { reason: "another check", job: { check_run_url: "https://api.github.com/repos/owner/repo/check-runs/101" } },
  { reason: "another repository", job: { check_run_url: "https://api.github.com/repos/other/repo/check-runs/100" } },
  { reason: "another head", job: { head_sha: "other" } },
  { reason: "a missing check URL", job: { check_run_url: undefined } },
  { reason: "an empty check URL", job: { check_run_url: "" } },
  { reason: "a missing workflow name", job: { workflow_name: null } },
  { reason: "an empty workflow name", job: { workflow_name: "" } },
  { reason: "an invalid workflow name", job: { workflow_name: 123 } },
  { reason: "an external provider", job: {}, app: { name: "External CI", slug: "external-ci" } },
])("workflow job metadata from $reason cannot change a CI label", ({ job, app = { name: "GitHub Actions", slug: "github-actions" } }) => {
  const log = frame("workflow_job", { action: "completed", workflow_job: workflowJob(job) })
    + frame("check_run", { action: "completed", check_run: check({ url: workflowJob().check_run_url, app, conclusion: "failure" }) });
  const { activities, text } = runLoggedHook(log);
  expect(activities).toHaveLength(1);
  expect(activities[0]).not.toHaveProperty("workflow");
  expect(text.trim()).toBe(`check_run/completed ${app.name} / test:failure`);
});

test.each([undefined, null, ""])("workflow job metadata preserves suite fallback when the check URL is %j", url => {
  const log = frame("workflow_job", { action: "completed", workflow_job: workflowJob({ workflow_name: "Other workflow" }) })
    + frame("workflow_run", { action: "requested", workflow_run: { id: 90, name: "Suite workflow", check_suite_id: 500, head_sha: "head" } })
    + frame("check_run", { action: "completed", check_run: check({ url, check_suite: { id: 500 } }) });
  const { activities, text } = runLoggedHook(log);
  expect(activities).toHaveLength(1);
  expect(activities[0].workflow).toBe("Suite workflow");
  expect(text.trim()).toBe("check_run/completed Suite workflow / test:success");
});

test("later workflow job metadata does not redeliver a completed check", () => {
  const completed = frame("check_run", { action: "completed", check_run: check({ url: workflowJob().check_run_url }) }, "checked");
  const { dir, run, activities } = runLoggedHook(completed);
  expect(activities[0]).not.toHaveProperty("workflow");
  const injected = readFileSync(join(dir, "injected.log"), "utf8");
  const metadata = ["queued", "in_progress", "completed"].map(action => frame("workflow_job", { action, workflow_job: workflowJob() }, `job-${action}`)).join("");
  writeFileSync(join(dir, "sse.jsonl"), completed + metadata);
  const repeated = run();
  expect(repeated.exitCode).toBe(0);
  expect(repeated.stderr.toString()).toBe("");
  expect(repeated.stdout.toString()).toBe("");
  expect(readFileSync(join(dir, "injected.log"), "utf8")).toBe(injected);
  expect(readFileSync(join(dir, "injected-deliveries.log"), "utf8")).toBe("checked\n");
});

test("workflow job metadata does not deliver the review workflow or its checks", () => {
  const log = frame("workflow_job", { action: "completed", workflow_job: workflowJob({ workflow_name: "agent invoke" }) })
    + frame("workflow_run", { action: "requested", workflow_run: { id: 90, name: "agent invoke", path: ".github/workflows/agent.yml", check_suite_id: 500, head_sha: "head" } })
    + frame("check_run", { action: "completed", check_run: check({ url: workflowJob().check_run_url, check_suite: { id: 500 } }) });
  const { output, dir } = runHook(log);
  expect(output).toBe("");
  expect(readFileSync(join(dir, "injected.log"), "utf8")).toBe("");
  expect(readFileSync(join(dir, "injected-deliveries.log"), "utf8")).toBe("");
});

test.each([
  { reason: "different suite", suite: 501, head: "head", app: { name: "GitHub Actions", slug: "github-actions" } },
  { reason: "different head", suite: 500, head: "other", app: { name: "GitHub Actions", slug: "github-actions" } },
  { reason: "another app", suite: 500, head: "head", app: { name: "External CI", slug: "external-ci" } },
])("CI labels do not borrow a workflow from $reason", ({ suite, head, app }) => {
  const log = frame("workflow_run", { action: "requested", workflow_run: { id: 90, name: "Unrelated workflow", path: ".github/workflows/ci.yml", check_suite_id: suite, head_sha: head } })
    + frame("check_run", { action: "completed", sender: bot, check_run: check({ app, check_suite: { id: 500 }, conclusion: "failure" }) });
  const { activities, text } = runLoggedHook(log);
  expect(activities).toHaveLength(1);
  expect(activities[0]).not.toHaveProperty("workflow");
  expect(text.trim()).toBe(`check_run/completed ${app.name} / test:failure`);
});

test("CI labels preserve events when workflow or app metadata is unavailable", () => {
  for (const [app, prefix] of [[{ name: "GitHub Actions", slug: "github-actions" }, "GitHub Actions / "], [{ slug: "external-ci" }, "external-ci / "], [{ name: "", slug: "github-actions" }, "github-actions / "], [undefined, ""]] as const) {
    const { activities, text } = runLoggedHook(frame("check_run", { action: "completed", sender: bot, check_run: check({ app, conclusion: "failure" }) }));
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({ sender: bot, check_run: { name: "test", conclusion: "failure" } });
    expect(activities[0]).not.toHaveProperty("workflow");
    expect(text.trim()).toBe(`check_run/completed ${prefix}test:failure`);
  }
});

test("CI labels omit workflow and status senders while comments still identify their author", () => {
  const log = frame("workflow_run", { action: "completed", sender: bot, workflow_run: { id: 90, head_sha: "head", name: "Build and lint", conclusion: "success" } })
    + frame("status", { sha: "head", state: "error", context: "security/scan", sender: bot })
    + frame("issue_comment", { action: "created", issue: { number: 7 }, comment: { body: "Please check", html_url: "https://github.com/owner/repo/pull/7#issuecomment-1" } });
  const { activities, text } = runLoggedHook(log);
  expect(activities.map(activity => activity.sender.login)).toEqual([bot.login, bot.login, human.login]);
  expect(text.trim().split(/\n+/)).toEqual([
    "workflow_run/completed Build and lint:success",
    "status security/scan:error",
    "issue_comment/created collaborator /pull/7#issuecomment-1",
  ]);
});

test("CI labels escape workflow names and both app labels before writing runner output", () => {
  const crafted = `CI ${"x".repeat(4096)}::error::forged\r\n\u2003:::warning:::payload\n##[error]synthetic`;
  const log = frame("workflow_run", { action: "requested", workflow_run: { id: 90, name: crafted, path: ".github/workflows/ci.yml", check_suite_id: 500, head_sha: "head" } })
    + frame("check_run", { action: "completed", check_run: check({ check_suite: { id: 500 } }) }, "workflow-label")
    + frame("check_run", { action: "completed", check_run: check({ app: { name: crafted, slug: "external-ci" } }) }, "app-name")
    + frame("check_run", { action: "completed", check_run: check({ app: { slug: crafted } }) }, "app-slug")
    + frame("workflow_job", { action: "queued", workflow_job: workflowJob({ workflow_name: crafted }) })
    + frame("check_run", { action: "completed", check_run: check({ url: workflowJob().check_run_url }) }, "job-workflow-label");
  const { activities, text } = runLoggedHook(log);
  expect([activities[0].workflow, activities[1].check_run.app.name, activities[2].check_run.app.slug, activities[3].workflow]).toEqual([crafted, crafted, crafted, crafted]);
  expect(text).not.toContain("::");
  expect(text).not.toContain("##[");
  expect(text).not.toContain("\r");
  expect(text.match(/:\u200b:error:\u200b:forged/g)).toHaveLength(4);
  expect(text.match(/#\u200b#\[error\]synthetic/g)).toHaveLength(4);
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
  expect(run('model = "m"\n').mcp_servers.gh).toEqual({ command: "uvx", args: ["gh-mcp"], required: true, startup_timeout_sec: 30, env_vars: ["GH_CONFIG_DIR", "UV_CACHE_DIR", "UV_TOOL_DIR", "UV_PYTHON_INSTALL_DIR"] });
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
  expect(run('[mcp_servers.other]\ncommand = "x"\n').mcp_servers).toEqual({ other: { command: "x" }, gh: { command: "uvx", args: ["gh-mcp"], required: true, startup_timeout_sec: 30, env_vars: ["GH_CONFIG_DIR", "UV_CACHE_DIR", "UV_TOOL_DIR", "UV_PYTHON_INSTALL_DIR"] } });
});

test("the catalog input overrides TOML keys without changing other values", () => {
  const { env } = fixture();
  const region = step("Configure codex").run.match(/printf '%s\\n' "\$CODEX_CONFIG"[\s\S]*?\n' "\$CODEX_HOME\/config\.toml"\n/)![0];
  for (const key of ["model_catalog_json", "  model_catalog_json", "\tmodel_catalog_json", '"model_catalog_json"', "'model_catalog_json'", '"model_catalog_\\u006ason"']) {
    const config = `${key} = "/old/models.json"\ndeveloper_instructions = """\nmodel_catalog_json = an example, not a setting\n"""\n[mcp_servers.other]\ncommand = "custom"\n`;
    const result = Bun.spawnSync(["bash", "-ec", region], { env: { ...env, CODEX_CONFIG: config, MODEL_CATALOG: ".github/models.json", GITHUB_ACTION_PATH: root } });
    expect(result.exitCode).toBe(0);
    const actual = Bun.TOML.parse(readFileSync(join(env.CODEX_HOME, "config.toml"), "utf8")) as any;
    expect(actual.model_catalog_json).toBe(join(env.CODEX_HOME, "models.json"));
    expect(actual.developer_instructions).toBe((Bun.TOML.parse(config) as any).developer_instructions);
    expect(actual.mcp_servers.other).toEqual({ command: "custom" });
    expect(actual.mcp_servers.gh).toEqual({ command: "uvx", args: ["gh-mcp"], required: true, startup_timeout_sec: 30, env_vars: ["GH_CONFIG_DIR", "UV_CACHE_DIR", "UV_TOOL_DIR", "UV_PYTHON_INSTALL_DIR"] });
    expect(actual.hooks.Stop[0].hooks[0].command).toBe(`bash ${root}/scripts/review-hook.sh`);
  }
});

test("each run reports the tokens every turn spent", () => {
  const { dir, env } = fixture();
  writeFileSync(join(dir, "codex.jsonl"), [
    { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 8, output_tokens: 2, reasoning_output_tokens: 1 } },
    { type: "turn.completed", usage: { input_tokens: 5, cached_input_tokens: 0, output_tokens: 3, reasoning_output_tokens: 0 } },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n");
  // The line and the totals come out of the same jq pass; the price is optional and absent without the table.
  const commands = step("Run codex review").run.match(/\{ read -r usage[\s\S]*?>> "\$GITHUB_STEP_SUMMARY"/)![0];
  const result = Bun.spawnSync(["bash", "-ec", commands], { env: { ...env, MODEL_NAME: "deepseek-flash" } });
  expect(result.exitCode).toBe(0);
  // The model is named because the config decides the provider; cached and reasoning refine the counts they follow.
  expect(result.stdout.toString()).toContain("deepseek-flash usage: 2 turns · 15 input, 53.3% cached · 5 output, 20% reasoning");
  expect(readFileSync(join(dir, "summary.md"), "utf8")).toContain("**deepseek-flash usage** — 2 turns · 15 input, 53.3% cached · 5 output, 20% reasoning");
  expect(result.stdout.toString()).not.toContain(" · $");
});

test("usage waits for the price table installed by its own step", () => {
  const { dir, env } = fixture(), run = step("Run codex review").run;
  writeFileSync(join(dir, "codex.jsonl"), JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 1 } }));
  executable(dir, "bun", `#!/usr/bin/env bash
if [ "$1" = add ]; then
  '${realSleep}' 0.1
  touch "$RUNNER_TEMP/installed"
else
  [ -f "$RUNNER_TEMP/installed" ] || exit 1
  echo '$0.123'
fi
`);
  const install = run.match(/\(mkdir -p[\s\S]*?PRICE_PID=\$!/)?.[0] || "";
  const report = run.match(/\{ read -r usage[\s\S]*?>> "\$GITHUB_STEP_SUMMARY"/)![0];
  const result = Bun.spawnSync(["bash", "-ec", `${install}\n${report}`], { env: { ...env, MODEL_NAME: "test-model" } });
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe("");
  expect(result.stdout.toString()).toContain(" · $0.123");
  expect(readFileSync(join(dir, "summary.md"), "utf8")).toContain(" · $0.123");
});

test("usage reads the root TOML tier and marks requested-tier prices as estimates", () => {
  const { dir, env } = fixture();
  const pkg = join(dir, "prices/node_modules/@pydantic/genai-prices");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@pydantic/genai-prices", type: "module", main: "index.js" }));
  // Flat rates isolate tier selection from the separate approximation for context-size tiers.
  writeFileSync(join(pkg, "index.js"), `export function calcPrice(usage, model, options) {
    const tier = options?.priceContext?.service_tier;
    return { total_price: tier === "flex" ? 0.2 : tier === "priority" ? 0.6 : 0.4, model_price: { input_mtok: 1, output_mtok: 1 } };
  }`);
  writeFileSync(join(dir, "codex.jsonl"), JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100000, cached_input_tokens: 0, output_tokens: 10000 } }));
  const report = step("Run codex review").run.match(/\{ read -r usage[\s\S]*?>> "\$GITHUB_STEP_SUMMARY"/)![0];
  for (const config of [
    'service_tier = "flex"\n',
    "service_tier = 'flex'\n",
    '  "service_tier" = "flex" # "requested tier"\n',
    'service_tier = "flex"\n[unrelated]\nservice_tier = "priority"\n',
  ]) {
    writeFileSync(join(dir, "config.toml"), config);
    for (const [input, price] of [["", "~$0.200"], ["default", "~$0.200"], ["priority", "~$0.600"]]) {
      writeFileSync(join(dir, "summary.md"), "");
      const result = Bun.spawnSync(["bash", "-ec", `true & PRICE_PID=$!\n${report}`], { env: { ...env, MODEL_NAME: "test-model", SERVICE_TIER: input } });
      expect(result.exitCode).toBe(0);
      expect(result.stderr.toString()).toBe("");
      expect(result.stdout.toString()).toContain(` · ${price}`);
      expect(readFileSync(join(dir, "summary.md"), "utf8")).toContain(` · ${price}`);
    }
  }
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
    expect(output).toContain(`\\"action\\":\\"${action}\\"`);
    expect(output).toContain("discussion_r1");
  }
});

test("a review comment carries the id its answer replies to", () => {
  const { output } = runHook(frame("pull_request_review_comment", { action: "created", pull_request: { number: 7 }, comment: { id: 4242, body: "how do I fix it", path: "file.ts", line: 8 } }));
  expect(output).toContain('\\"id\\":4242');
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

test("a broker skip response skips every action step before saving credentials", () => {
  const {dir,env}=fixture(), output=join(dir,"github-output");
  executable(dir,"curl",`#!/bin/sh\ncase "$*" in */oidc*) echo '{"value":"fixture-oidc"}' ;; *) echo '{"skip":true}' ;; esac\n`);
  const steps=Bun.YAML.parse(readFileSync(join(root,"action.yml"),"utf8")).runs.steps;
  const result=Bun.spawnSync(["bash","-eo","pipefail","-c",steps[0].run],{env:{...env,GITHUB_OUTPUT:output,ACTIONS_ID_TOKEN_REQUEST_URL:"https://example.test/oidc?fixture=1",ACTIONS_ID_TOKEN_REQUEST_TOKEN:"fixture",BROKER:"https://example.test"},timeout:3000});
  expect(result.exitCode).toBe(0);
  expect(readFileSync(output,"utf8")).toBe("skip=true\n");
  expect(existsSync(join(dir,"gh/hosts.yml"))).toBe(false);
  for(const step of steps.slice(1)) expect(step.if).toContain("steps.app-token.outputs.skip != 'true'");
});

test("token requests identify PR targets without treating issue or branch jobs as PRs", () => {
  const steps=Bun.YAML.parse(readFileSync(join(root,"action.yml"),"utf8")).runs.steps;
  for (const [event,body,pr,target] of [["pull_request",{pull_request:{number:7}},"","pull_request"],["issue_comment",{issue:{pull_request:{}}},"","pull_request"],["repository_dispatch",{},"7","pull_request"],["issue_comment",{issue:{number:7}},"","other"],["push",{ref:"refs/heads/main"},"","other"],["issues",{issue:{number:7}},"","other"],["workflow_dispatch",{},"","other"],["check_run",{check_run:{pull_requests:[{number:7}]}},"","pull_request"],["workflow_run",{},"","pull_request"],["unknown",{},"","pull_request"]] as const) {
    const {dir,env}=fixture();
    writeFileSync(join(dir,"event.json"),JSON.stringify(body));
    executable(dir,"curl",`#!/bin/sh\nprintf '%s\\n' "$@" >> "$RUNNER_TEMP/curl-args"\ncase "$*" in */oidc*) echo '{"value":"fixture-oidc"}' ;; *) echo '{"skip":true}' ;; esac\n`);
    const result=Bun.spawnSync(["bash","-eo","pipefail","-c",steps[0].run],{env:{...env,GITHUB_EVENT_NAME:event,DISPATCHED_PR:pr,GITHUB_OUTPUT:join(dir,"github-output"),ACTIONS_ID_TOKEN_REQUEST_URL:"https://example.test/oidc?fixture=1",ACTIONS_ID_TOKEN_REQUEST_TOKEN:"fixture",BROKER:"https://example.test"},timeout:3000});
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(dir,"curl-args"),"utf8")).toContain(`X-Review-Target: ${target}\n`);
  }
});

test("check suite identities retain their suite id and reviewed head", () => {
  const {dir}=fixture(), path=join(dir,"event.json");
  const ids=[];
  for(const [id,head] of [[1,"a"],[2,"a"],[2,"b"]]) {
    writeFileSync(path,JSON.stringify({action:"completed",check_suite:{id,head_sha:head},sender:human}));
    const actual=/ACTIVITY_ID=(.*)/.exec(runGate(dir,{GITHUB_EVENT_NAME:"check_suite",GITHUB_EVENT_PATH:path}))![1];
    expect(actual).toBe(new Bun.CryptoHasher("sha256").update(`check_suite:completed:${id}:${head}:`).digest("hex").slice(0,40));
    ids.push(actual);
  }
  expect(new Set(ids).size).toBe(3);
});

test("injected changes link to the received commit in its PR when available", () => {
  const head = "0123456789abcdef0123456789abcdef01234567";
  const input = [{ event: "push", after: head }, { event: "pull_request", action: "synchronize", pull_request: { head: { sha: head } } }, { event: "push", after: "unknown" }, { event: "push", after: "0".repeat(40) }, { event: "issue_comment", comment: { html_url: "/pull/7#issuecomment-1" } }].map((event) => JSON.stringify(event)).join("\n");
  for (const pr of ["7", ""]) {
    const result = Bun.spawnSync(["jq", "-Rr", "-f", join(root, "scripts/injected-log.jq")], { stdin: Buffer.from(input), env: { ...process.env, PR_NUMBER: pr } });
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.toString().split("\n").filter(Boolean);
    const path = pr ? `/pull/${pr}/commits/${head}` : `/commit/${head}`;
    for (const line of lines.slice(0, 2)) expect(line).toEndWith(path);
    for (const line of lines.slice(2, 4)) expect(line).not.toContain("/commit");
    expect(lines[4]).toEndWith("/pull/7#issuecomment-1");
  }
});

test.each([".github/workflows/agent.yml", ".github/workflows/agent.yml@main", ".github/workflows/agent.yml@refs/heads/release@v2"].flatMap(path => ["true", ""].map(REVIEW_HOSTED => ({ path, REVIEW_HOSTED }))))("hosted UUID resolves workflow ID (%j)", ({ path, REVIEW_HOSTED }) => {
  const { result, dir } = runCI([{ pages: [{ check_runs: [check(), check({ id: 101, status: "queued", check_suite: { id: 7 } })] }] }], "", [".", "pass"],
    { REVIEW_HOSTED, GITHUB_RUN_ID: "review-uuid", GITHUB_WORKFLOW_REF: "owner/repo/.github/workflows/agent.yml@refs/heads/release@v2", WAIT_CI_TIMEOUT: "1" },
    [{ pages: [{ workflow_runs: [{ id: 99, workflow_id: 42, path, name: "review", check_suite_id: 7 }] }] }]);
  expect(result.exitCode).toBe(0);
  expect(readFileSync(join(dir, "gh-args"), "utf8")).not.toContain("actions/runs/review-uuid");
  expectTailReleased(dir);
});

test.each([".github/workflows/other.yml", ".github/workflows/renamed.yml"])("hosted supplied path never falls back to a shared workflow name (%s)", path => {
  const { result, dir } = runCI([{ pages: [{ check_runs: [check(), check({ id: 101, status: "queued", check_suite: { id: 7 } })] }] }], "", [".", "pass"],
    { REVIEW_HOSTED: "true", GITHUB_RUN_ID: "review-uuid", GITHUB_WORKFLOW: "review", WAIT_CI_TIMEOUT: "1" },
    [{ pages: [{ workflow_runs: [{ id: 99, path, name: "review", check_suite_id: 7 }] }] }]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("No CI checks matching");
  expectTailReleased(dir);
});

test.each(["", "owner/repo/.github/workflows/agent.yml@refs/heads/main"])("hosted retains a failed same-name workflow with ref %s", GITHUB_WORKFLOW_REF => {
  const { result, dir } = runCI([{ pages: [{ check_runs: [check(), check({ id: 101, name: "integration", conclusion: "failure", check_suite: { id: 7 } })] }] }], "", [".", "pass"],
    { REVIEW_HOSTED: "true", GITHUB_RUN_ID: "review-uuid", GITHUB_WORKFLOW_REF, GITHUB_WORKFLOW: "review", WAIT_CI_TIMEOUT: "1" },
    [{ pages: [{ workflow_runs: [{ id: 99, path: ".github/workflows/integration.yml", name: "review", check_suite_id: 7 }] }] }]);
  expect(result.exitCode).toBe(1);
  expect(result.stdout.toString()).toContain("integration: failure");
  expectTailReleased(dir);
});

test("hosted without workflow ref retains queued checks despite a shared name", () => {
  const { result, dir } = runCI([{ pages: [{ check_runs: [check(), check({ id: 101, status: "queued", check_suite: { id: 7 } })] }] }], "", [".", "pass"],
    { REVIEW_HOSTED: "true", GITHUB_RUN_ID: "review-uuid", GITHUB_WORKFLOW_REF: "", GITHUB_WORKFLOW: "review", WAIT_CI_TIMEOUT: "1" },
    [{ pages: [{ workflow_runs: [{ id: 99, path: ".github/workflows/integration.yml", name: "review", check_suite_id: 7 }] }] }]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("No CI checks matching");
  expectTailReleased(dir);
});

test("hosted failed later pagination retains all checks", () => {
  const { result, dir } = runCI([{ pages: [{ check_runs: [check(), check({ id: 101, status: "queued", check_suite: { id: 7 } })] }] }], "", [".", "pass"],
    { REVIEW_HOSTED: "true", GITHUB_RUN_ID: "review-uuid", WAIT_CI_TIMEOUT: "1" },
    [{ pages: [{ workflow_runs: [{ id: 99, workflow_id: 42, path: ".github/workflows/agent.yml", check_suite_id: 7 }] }], error: "HTTP 502: next page failed" }]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("No CI checks matching");
  expectTailReleased(dir);
});

test.each(["other/repo/.github/workflows/agent.yml@refs/heads/main", "owner/repo/.github/workflows/agent.yml@", "owner/repo/.github/workflows/agent.yml@refs/heads/bad..ref", "invalid-ref"])("hosted invalid nonempty workflow ref keeps checks (%s)", GITHUB_WORKFLOW_REF => {
  const { result, dir } = runCI([{ pages: [{ check_runs: [check({ status: "queued", check_suite: { id: 7 } })] }] }], "", [".", "pass"],
    { REVIEW_HOSTED: "true", GITHUB_RUN_ID: "review-uuid", GITHUB_WORKFLOW_REF, GITHUB_WORKFLOW: "review", WAIT_CI_TIMEOUT: "1" });
  expect(result.exitCode).toBe(1);
  expect(readFileSync(join(dir, "gh-args"), "utf8")).not.toContain("/actions/runs");
  expectTailReleased(dir);
});

test("hosted numeric attempt ID still selects by workflow path", () => {
  const { result, dir } = runCI([{ pages: [{ check_runs: [check(), check({ id: 101, status: "queued", check_suite: { id: 7 } })] }] }], "", [".", "pass"],
    { REVIEW_HOSTED: "true", GITHUB_RUN_ID: "12", WAIT_CI_TIMEOUT: "1" },
    [{ pages: [{ workflow_runs: [{ id: 12, workflow_id: 42, path: ".github/workflows/agent.yml", check_suite_id: 7 }] }] }]);
  expect(result.exitCode).toBe(0);
  expect(readFileSync(join(dir, "gh-args"), "utf8")).not.toContain("actions/runs/12");
  expectTailReleased(dir);
});

test("hosted recomputes sibling suites when a new queued run appears", () => {
  const { result, calls, dir } = runCI([
    { pages: [{ check_runs: [check({ status: "in_progress" })] }] },
    { pages: [{ check_runs: [check(), check({ id: 101, status: "queued", check_suite: { id: 7 } })] }] },
  ], frame("status", { sha: "head", state: "success" }), [".", "pass"], { REVIEW_HOSTED: "true", GITHUB_RUN_ID: "review-uuid", WAIT_CI_TIMEOUT: "5" }, [
    { pages: [{ workflow_runs: [] }] },
    { pages: [{ workflow_runs: [{ id: 99, workflow_id: 42, path: ".github/workflows/agent.yml", check_suite_id: 7 }] }] },
  ]);
  expect(result.exitCode).toBe(0);
  expect(calls).toBe(2);
  expectTailReleased(dir);
});

test.each([
  { WORKFLOW_LOOKUP_FAIL: "1" },
  { WORKFLOW_LOOKUP_BAD_ID: "1" },
  { WORKFLOW_LOOKUP_PATH: ".github/workflows/renamed.yml" },
])("hosted failed or mismatched workflow lookup retains checks (%j)", lookup => {
  const { result, dir } = runCI([{ pages: [{ check_runs: [check({ conclusion: "failure", check_suite: { id: 7 } })] }] }], "", [".", "pass"],
    { REVIEW_HOSTED: "true", GITHUB_RUN_ID: "review-uuid", ...lookup },
    [{ pages: [{ workflow_runs: [{ id: 99, workflow_id: 42, path: ".github/workflows/agent.yml@main", check_suite_id: 7 }] }] }]);
  expect(result.exitCode).toBe(1);
  expect(result.stdout.toString()).toContain("test: failure");
  expect(readFileSync(join(dir, "gh-args"), "utf8")).not.toContain("actions/runs");
  expectTailReleased(dir);
});

test("hosted same run path with different workflow ID retains failure", () => {
  const { result, dir } = runCI([{ pages: [{ check_runs: [check({ conclusion: "failure", check_suite: { id: 7 } })] }] }], "", [".", "pass"],
    { REVIEW_HOSTED: "true", GITHUB_RUN_ID: "review-uuid" },
    [{ pages: [{ workflow_runs: [{ id: 99, workflow_id: 43, path: ".github/workflows/agent.yml@main", check_suite_id: 7 }] }] }]);
  expect(result.exitCode).toBe(1);
  expect(result.stdout.toString()).toContain("test: failure");
  expectTailReleased(dir);
});
