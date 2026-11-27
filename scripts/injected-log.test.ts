import { afterEach, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const realTail = Bun.which("tail")!;
const head = "c342a0e73079da37ef300f6ed1473d3ca63982b4";
const fixtures: { dir: string; process?: ReturnType<typeof Bun.spawn> }[] = [];
const event = (suite = 100, name = "check (windows, 3.12)", extra: Record<string, unknown> = {}) => {
  const { workflow, ...check } = extra;
  return { event: "check_run", action: "completed", sender: { login: "dependabot[bot]", type: "Bot" },
    check_run: { id: 1, app: { name: "GitHub Actions", slug: "github-actions" }, check_suite: { id: suite }, head_sha: head, name, conclusion: "success", ...check },
    ...(workflow === undefined ? {} : { workflow }) };
};
const run = (suite = 100, name = "CI", extra = {}) => ({ workflow_runs: [{ id: 90, check_suite_id: suite, head_sha: head, name, ...extra }] });

function fixture(responses: Record<string, object> = {}, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "review-ci-log-"));
  const setup: typeof fixtures[number] = { dir };
  fixtures.push(setup);
  writeFileSync(join(dir, "injected.log"), "");
  writeFileSync(join(dir, "responses.json"), JSON.stringify(responses));
  writeFileSync(join(dir, "tail"), `#!/usr/bin/env bash\nprintf '%s\\n' "$$" > "$RUNNER_TEMP/tail.pid"\nexec ${JSON.stringify(realTail)} "$@"\n`);
  writeFileSync(join(dir, "gh"), `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync } from "node:fs";
const dir = process.env.RUNNER_TEMP;
const argv = process.argv.slice(2);
const suite = /check_suite_id=(\\d+)/.exec(argv[1])?.[1];
appendFileSync(dir + "/calls", JSON.stringify({ argv, token: process.env.GH_TOKEN, config: process.env.GH_CONFIG_DIR, stdin: readFileSync(0, "utf8") }) + "\\n");
const response = JSON.parse(readFileSync(dir + "/responses.json", "utf8"))[suite] || {};
if (response.wait) while (!existsSync(dir + "/release")) await Bun.sleep(10);
if (response.hang) await Bun.sleep(30000);
if (response.fail) { console.error("HTTP 403"); process.exit(1); }
console.log(JSON.stringify(response.body || {}));
`);
  for (const name of ["gh", "tail"]) chmodSync(join(dir, name), 0o755);
  return { setup, dir, env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, RUNNER_TEMP: dir, LOG_RENDERED: "", GITHUB_ACTION_PATH: root, GITHUB_REPOSITORY: "owner/repo", GH_CONFIG_DIR: join(dir, "gh-config"), REVIEW_ACTIONS_TOKEN: "job-token", GH_TOKEN: "app-token", GITHUB_TOKEN: "", ...env } };
}

async function until(predicate: () => boolean, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for log worker");
    await Bun.sleep(10);
  }
}

function groupTitles(output: string) {
  return output.split("\n").filter(line => line.startsWith("::group::")).map(line => line.slice("::group::".length));
}

function start(responses: Record<string, object> = {}, env = {}) {
  const setup = fixture(responses, env);
  const process = Bun.spawn(["bash", join(import.meta.dir, "injected-log.sh"), join(setup.dir, "injected.log")], { env: setup.env, stdout: "pipe", stderr: "pipe" });
  setup.setup.process = process;
  let output = "";
  const stdout = (async () => { for await (const chunk of process.stdout) output += new TextDecoder().decode(chunk); })();
  const stderr = new Response(process.stderr).text();
  const append = (...events: object[]) => appendFileSync(join(setup.dir, "injected.log"), events.map(value => JSON.stringify(value)).join("\n") + "\n");
  return {
    ...setup, process, append,
    output: () => output.replace(/\x1b\[[0-9;]*m/g, ""),
    calls: () => existsSync(join(setup.dir, "calls")) ? readFileSync(join(setup.dir, "calls"), "utf8").trim().split("\n").map(value => JSON.parse(value)) : [],
    finish: async () => {
      writeFileSync(join(setup.dir, "injected.done"), "");
      append({ review_log_end: true });
      expect(await process.exited).toBe(0);
      await stdout;
      expect(await stderr).toBe("");
      expect(output).not.toContain("review_log_end");
      expect(() => globalThis.process.kill(Number(readFileSync(join(setup.dir, "tail.pid"), "utf8")), 0)).toThrow();
    },
  };
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    if (fixture.process?.exitCode === null) { fixture.process.kill(); await fixture.process.exited; }
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("CI log resolves and caches the exact suite using only the Actions credential", async () => {
  const log = start({ 100: { body: run() } });
  log.append(event(), event(100, "check (windows, 3.13)"));
  await until(() => log.output().includes("CI / check (windows, 3.13):success"));
  await log.finish();
  expect(log.output()).toContain("CI / check (windows, 3.12):success");
  expect(groupTitles(log.output()).join("\n")).not.toContain("dependabot");
  expect(log.calls()).toEqual([{ argv: ["api", "repos/owner/repo/actions/runs?check_suite_id=100&per_page=1"], token: "job-token", config: log.env.GH_CONFIG_DIR, stdin: "" }]);
});

test.each([
  { path: "GitHub Action", REVIEW_HOSTED: "", REVIEW_ACTIONS_TOKEN: "job-token", GH_TOKEN: "app-token" },
  { path: "Hosted Review", REVIEW_HOSTED: "true", REVIEW_ACTIONS_TOKEN: "", GH_TOKEN: "" },
])("$path logs faithful webhook records once with their owners and links", async ({ path, ...env }) => {
  const log = start({ 100: { body: run() } }, { ...env, PR_NUMBER: "7" });
  const sender = { login: "alice", type: "User" };
  const records = [
    event(100, "dependabot job", { details_url: "/actions/runs/90/job/1" }),
    { ...event(100, "human job", { id: 2, details_url: "/actions/runs/90/job/2" }), sender },
    { ...event(200, "Proof", { app: { name: "blacksmith.sh", slug: "blacksmith-sh" }, conclusion: "skipped", details_url: "https://blacksmith.sh/check/3" }), sender },
    { event: "workflow_run", action: "completed", sender, workflow_run: { id: 90, name: "CI", check_suite_id: 100, head_sha: head, conclusion: "success", html_url: "/actions/runs/90" } },
    { event: "issue_comment", action: "created", sender, issue: { number: 7 }, comment: { id: 4, body: "Please check this", html_url: "/pull/7#issuecomment-4" } },
    { event: "pull_request_review", action: "submitted", sender, pull_request: { number: 7, head: { sha: head } }, review: { state: "approved", body: "Reviewed", html_url: "/pull/7#pullrequestreview-5" } },
    { event: "pull_request_review_comment", action: "created", sender, pull_request: { number: 7 }, comment: { id: 6, commit_id: head, path: "file.ts", line: 12, body: "This line", html_url: "/pull/7#discussion_r6" } },
    { event: "pull_request_review_thread", action: "resolved", sender, pull_request: { number: 7 }, thread: { node_id: "thread-7", comments: [{ body: "Resolved", path: "file.ts", line: 12, html_url: "/pull/7#discussion_r6" }] } },
    { event: "commit_comment", action: "created", sender, comment: { id: 8, commit_id: head, path: "file.ts", line: 12, body: "Commit note", html_url: `/commit/${head}#commitcomment-8` } },
    { event: "push", sender, ref: "refs/heads/feature", after: head },
    { event: "status", sender: { login: "github-actions[bot]", type: "Bot" }, context: "external/check", state: "failure", sha: head, target_url: "https://ci.example.test/9" },
    { event: "subscription_recovery", reason: "connection_closed", status: 502, recovery: "Reconcile the current GitHub state." },
  ];
  log.append(...records);
  await until(() => log.output().includes("subscription_recovery"));
  await log.finish();
  expect(groupTitles(log.output())).toEqual([
    "check_run/completed CI / dependabot job:success /actions/runs/90/job/1",
    "check_run/completed CI / human job:success /actions/runs/90/job/2",
    "check_run/completed blacksmith.sh / Proof:skipped https://blacksmith.sh/check/3",
    "workflow_run/completed CI:success /actions/runs/90",
    "issue_comment/created alice /pull/7#issuecomment-4",
    "pull_request_review/submitted alice /pull/7#pullrequestreview-5",
    "pull_request_review_comment/created alice /pull/7#discussion_r6",
    "pull_request_review_thread/resolved alice /pull/7#discussion_r6",
    `commit_comment/created alice /commit/${head}#commitcomment-8`,
    `push alice /pull/7/commits/${head}`,
    "status external/check:failure https://ci.example.test/9",
    "subscription_recovery",
  ]);
  expect(log.calls()).toHaveLength(1);
  expect(log.calls()[0]).toMatchObject({ token: env.REVIEW_ACTIONS_TOKEN || env.GH_TOKEN, config: log.env.GH_CONFIG_DIR, stdin: "" });
  expect(readFileSync(join(log.dir, "injected.log"), "utf8").trim().split("\n").map(row => JSON.parse(row))).toEqual([...records, { review_log_end: true }]);
});

test.each([
  { reason: "permission denied", response: { fail: true } },
  { reason: "wrong suite", response: { body: run(101) } },
  { reason: "wrong head", response: { body: run(100, "Other workflow", { head_sha: "0".repeat(40) }) } },
  { reason: "missing name", response: { body: run(100, "") } },
])("CI log preserves checks and caches a $reason lookup", async ({ response }) => {
  const log = start({ 100: response });
  log.append(event(), event(100, "second job"), event(100, "known job", { workflow: "Known workflow" }));
  await until(() => log.output().includes("Known workflow / known job:success"));
  await log.finish();
  expect(log.output()).toContain("GitHub Actions / check (windows, 3.12):success");
  expect(log.output()).toContain("GitHub Actions / second job:success");
  expect(log.calls()).toHaveLength(1);
});

test("CI log uses the hosted credential and escapes API-supplied names", async () => {
  const log = start({ 100: { body: run(100, "CI\n::error::forged\n##[error]synthetic") } }, { REVIEW_ACTIONS_TOKEN: "", GH_TOKEN: "" });
  log.append(event());
  await until(() => log.output().includes("check (windows, 3.12):success"));
  await log.finish();
  expect(log.calls()[0]).toMatchObject({ token: "", config: log.env.GH_CONFIG_DIR });
  for (const line of log.output().split("\n").filter(line => line.startsWith("::"))) {
    expect(line === "::endgroup::" || line.startsWith("::group::")).toBe(true);
  }
  expect(log.output()).not.toContain("##[");
});

test("CI log never looks up other providers, missing identities or a supplied workflow", async () => {
  const log = start();
  log.append(event(100, "Proof", { app: { name: "blacksmith.sh", slug: "blacksmith-sh" } }), event(100, "known", { workflow: "Build" }), event(-1, "invalid suite"), event(100, "missing head", { head_sha: undefined }), { event: "issue_comment", sender: { login: "alice" } });
  await until(() => log.output().includes("issue_comment alice"));
  await log.finish();
  expect(log.calls()).toHaveLength(0);
  expect(log.output()).toContain("blacksmith.sh / Proof:success");
  expect(log.output()).toContain("Build / known:success");
});

test("CI log drains an in-flight lookup and queued events when the review ends", async () => {
  const log = start({ 100: { wait: true, body: run() }, 200: { body: run(200, "Never requested") } });
  log.append(event());
  await until(() => log.calls().length === 1);
  log.append(event(200, "last job"), { event: "issue_comment", sender: { login: "alice" } });
  const finished = log.finish();
  writeFileSync(join(log.dir, "release"), "");
  await finished;
  expect(log.output()).toContain("CI / check (windows, 3.12):success");
  expect(log.output()).toContain("GitHub Actions / last job:success");
  expect(log.output()).toContain("issue_comment alice");
  expect(log.calls()).toHaveLength(1);
});

test("a timed-out CI lookup cannot drop the final event or hold the worker open", async () => {
  const log = start({ 100: { hang: true } });
  log.append(event());
  await until(() => log.calls().length === 1);
  await log.finish();
  expect(log.output()).toContain("GitHub Actions / check (windows, 3.12):success");
}, 7000);

test.each(["job-token", ""])("the review isolates its optional Actions credential (%j)", token => {
  const { dir, env } = fixture({ 100: { body: run() } }, { REVIEW_ACTIONS_TOKEN: token });
  writeFileSync(join(dir, "event.json"), JSON.stringify({ action: "opened", sender: { login: "alice" }, issue: { number: 7 } }));
  writeFileSync(join(dir, "bun"), `#!/usr/bin/env bash\nif [[ $1 == --config=* ]]; then exec '${process.execPath}' "$@"; fi\nprintf "%s\\n" "\${REVIEW_ACTIONS_TOKEN-unset}" >> "$RUNNER_TEMP/price-tokens"\n`);
  writeFileSync(join(dir, "codex"), `#!${process.execPath}
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
const dir = process.env.RUNNER_TEMP;
writeFileSync(dir + "/codex-env", JSON.stringify({ token: process.env.REVIEW_ACTIONS_TOKEN ?? null, appToken: process.env.GH_TOKEN, config: process.env.GH_CONFIG_DIR }));
appendFileSync(dir + "/injected.log", JSON.stringify(${JSON.stringify(event())}) + "\\n");
const deadline = Date.now() + 2000;
while (!existsSync(dir + "/calls")) {
  if (Date.now() > deadline) process.exit(1);
  await Bun.sleep(10);
}
console.log(JSON.stringify({ type: "thread.started", thread_id: "fixture" }));
`);
  for (const name of ["bun", "codex"]) chmodSync(join(dir, name), 0o755);
  const result = Bun.spawnSync(["bash", join(import.meta.dir, "run-review.sh")], {
    env: { ...env, AGENT: "true", PR_NUMBER: "", CHECK_ID: "", ISSUE_NUMBER: "7", BASE: "main", FORK_KEY: "", HEAD_SHA: head,
      CODEX_HOME: dir, CODEX_BIN: join(dir, "codex"), CODEX_RUNTIME: "", GITHUB_EVENT_NAME: "issues", GITHUB_EVENT_PATH: join(dir, "event.json"), GITHUB_STEP_SUMMARY: join(dir, "summary.md") },
    timeout: 5000,
  });
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(readFileSync(join(dir, "codex-env"), "utf8"))).toEqual({ token: null, appToken: "app-token", config: env.GH_CONFIG_DIR });
  expect(readFileSync(join(dir, "price-tokens"), "utf8").trim().split("\n")).toEqual(["unset", "unset"]);
  expect(JSON.parse(readFileSync(join(dir, "calls"), "utf8").trim()).token).toBe(token || "app-token");
  expect(result.stdout.toString()).toContain("CI / check (windows, 3.12):success");
}, 7000);

test.each(["rejected resume", "missing verdict"])("the live log survives %s and drains activity after the final attempt", async mode => {
  const { setup, dir, env } = fixture({ 100: { wait: true, body: run() } });
  const comment = (id: number) => ({ event: "issue_comment", action: "created", sender: { login: "alice" },
    comment: { id, body: `${id}: ${"边界🙂".repeat(4096)}`, html_url: `/pull/7#issuecomment-${id}` } });
  const records = [comment(1), event(100, "between attempts", { id: 2 }), comment(3), comment(4)];
  writeFileSync(join(dir, "records.json"), JSON.stringify(records));
  writeFileSync(join(dir, "last-record"), JSON.stringify(records[3]) + "\n");
  writeFileSync(join(dir, "event.json"), JSON.stringify({ action: "opened", sender: { login: "alice" }, issue: { number: 7 } }));
  if (mode === "rejected resume") writeFileSync(join(dir, "last-thread-id"), "previous-thread\n");
  // Pricing runs after the last log() pipeline. Its final delivery can only be printed by the EXIT drain.
  writeFileSync(join(dir, "bun"), `#!/usr/bin/env bash
if [[ $1 == --config=* ]]; then exec '${process.execPath}' "$@"; fi
if [[ $1 == -e ]]; then cat "$RUNNER_TEMP/last-record" >> "$RUNNER_TEMP/injected.log"; fi
`);
  writeFileSync(join(dir, "codex"), `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const dir = process.env.RUNNER_TEMP;
const attempts = dir + "/attempts.jsonl";
const attempt = existsSync(attempts) ? readFileSync(attempts, "utf8").trim().split("\\n").length + 1 : 1;
appendFileSync(attempts, JSON.stringify({ attempt, resume: process.argv[3] === "resume" }) + "\\n");
const records = JSON.parse(readFileSync(dir + "/records.json", "utf8"));
const append = index => appendFileSync(dir + "/injected.log", JSON.stringify(records[index]) + "\\n");
const waitFor = async predicate => {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Fixture gate was not released");
    await Bun.sleep(10);
  }
};
console.log(JSON.stringify({ type: "thread.started", thread_id: "fixture-thread" }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "bash -lc 'attempt-" + attempt + "'",
  aggregated_output: "tool-" + attempt + "\\n" + "完整 output 🙂".repeat(8192) + "\\nend-" + attempt + "\\n" } }));
if (attempt === 1) {
  await waitFor(() => existsSync(dir + "/deliver-first"));
  append(0);
  // The parent waits for the actual visible activity while this Codex stdout stays open and idle.
  await waitFor(() => existsSync(dir + "/release-first"));
  append(1);
  // Keep this record's real activity formatter behind an in-flight metadata lookup across log() attempts.
  await waitFor(() => existsSync(dir + "/calls") && readFileSync(dir + "/calls", "utf8").includes("check_suite_id=100"));
  if (process.env.RETRY_MODE === "rejected resume") {
    console.log(JSON.stringify({ type: "error", message: "modelProviderMismatch" }));
    process.exit(1);
  }
} else {
  await waitFor(() => existsSync(dir + "/deliver-second"));
  append(2);
  await waitFor(() => existsSync(dir + "/release-second"));
  const output = process.argv[process.argv.indexOf("--output-last-message") + 1];
  writeFileSync(output, JSON.stringify({ conclusion: "success", summary: "complete", commits: [{ sha: process.env.HEAD_SHA, conclusion: "success" }] }));
}
`);
  for (const name of ["bun", "codex"]) chmodSync(join(dir, name), 0o755);
  const child = Bun.spawn(["bash", join(import.meta.dir, "run-review.sh")], {
    env: { ...env, RETRY_MODE: mode, AGENT: String(mode === "rejected resume"), PR_NUMBER: "", CHECK_ID: "1", ISSUE_NUMBER: "7",
      BASE: "main", HEAD_BRANCH: "fixture", FORK_KEY: "", HEAD_SHA: head, BEFORE: "", DISPATCHED_SHA: head, DISPATCHED_BASE: "main",
      CODEX_HOME: dir, CODEX_BIN: join(dir, "codex"), CODEX_RUNTIME: "", REVIEW_HOSTED: "", REVIEW_TRACE_RELAY_URL: "",
      GITHUB_EVENT_NAME: "issues", GITHUB_EVENT_PATH: join(dir, "event.json"), GITHUB_STEP_SUMMARY: join(dir, "summary.md") },
    stdout: "pipe", stderr: "pipe", timeout: 10000,
  });
  setup.process = child;
  let output = "";
  const decoder = new TextDecoder();
  const stdout = (async () => {
    for await (const chunk of child.stdout) output += decoder.decode(chunk, { stream: true });
    output += decoder.decode();
  })();
  const stderr = new Response(child.stderr).text();
  try {
    await until(() => output.includes("end-1\u001b[0m\n::endgroup::"), 5000);
    writeFileSync(join(dir, "deliver-first"), "");
    await until(() => output.includes("/pull/7#issuecomment-1"), 5000);
    // The gate holds the worker at this complete frame; stdout can arrive before its cursor write finishes.
    const firstOffset = readFileSync(join(dir, "injected.rendered")).lastIndexOf(10) + 1;
    await until(() => firstOffset > 0 && existsSync(join(dir, "injected.offset"))
      && Number(readFileSync(join(dir, "injected.offset"), "utf8")) === firstOffset, 5000);
    expect(child.exitCode).toBeNull();
    expect(firstOffset).toBeGreaterThan(0);
    writeFileSync(join(dir, "release-first"), "");
    await until(() => readFileSync(join(dir, "attempts.jsonl"), "utf8").trim().split("\n").length === 2, 5000);
    await until(() => output.includes("end-2\u001b[0m\n::endgroup::"), 5000);
    writeFileSync(join(dir, "release"), "");
    writeFileSync(join(dir, "deliver-second"), "");
    await until(() => output.includes("/pull/7#issuecomment-3"), 5000);
    const secondOffset = readFileSync(join(dir, "injected.rendered")).lastIndexOf(10) + 1;
    await until(() => secondOffset > firstOffset
      && Number(readFileSync(join(dir, "injected.offset"), "utf8")) === secondOffset, 5000);
    expect(Number(readFileSync(join(dir, "injected.offset"), "utf8"))).toBeGreaterThan(firstOffset);
    writeFileSync(join(dir, "release-second"), "");
    expect(await child.exited).toBe(0);
    await stdout;
    expect(await stderr).toBe("");
  } finally {
    for (const name of ["release", "deliver-first", "deliver-second", "release-first", "release-second"]) writeFileSync(join(dir, name), "");
  }
  const visible = output.replace(/\x1b\[[0-9;]*m/g, "");
  const groups = [...visible.matchAll(/^::group::([^\n]*)\n([\s\S]*?)^::endgroup::$/gm)];
  const activities = groups.filter(([, title]) => !title.startsWith("$ ")).map(([, , body]) => JSON.parse(body));
  expect(activities).toEqual(records);
  expect(groups.filter(([, title]) => title.startsWith("$ ")).map(([, title, body]) => [title, body])).toEqual([1, 2].map(attempt => [
    `$ attempt-${attempt}`, `tool-${attempt}\n${"完整 output 🙂".repeat(8192)}\nend-${attempt}\n`,
  ]));
  expect(visible.indexOf("/pull/7#issuecomment-4")).toBeGreaterThan(visible.indexOf("::notice::"));
  expect(Number(readFileSync(join(dir, "injected.offset"), "utf8"))).toBe(readFileSync(join(dir, "injected.rendered")).length);
  expect(readFileSync(join(dir, "attempts.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line).resume))
    .toEqual(mode === "rejected resume" ? [true, false] : [false, true]);
  expect(() => process.kill(Number(readFileSync(join(dir, "tail.pid"), "utf8")), 0)).toThrow();
}, 15000);

test("activity remains live during the capacity cooldown and is not replayed by the next mux", async () => {
  const { setup, dir, env } = fixture();
  const source = readFileSync(join(import.meta.dir, "run-review.sh"), "utf8");
  const region = source.slice(source.indexOf(': > "$RUNNER_TEMP/injected.log"'), source.indexOf("trap finish_injected EXIT") + "trap finish_injected EXIT".length);
  const cooldown = source.match(/    if grep -Eq 'capacity\|overloaded\|too many requests'[\s\S]*?\n    fi/)?.[0];
  expect(cooldown).toBeDefined();
  writeFileSync(join(dir, "codex.jsonl"), "capacity\n");
  writeFileSync(join(dir, "sleep"), `#!${process.execPath}
import { existsSync, writeFileSync } from "node:fs";
if (process.argv[2] !== "30") throw new Error("Expected the production cooldown");
writeFileSync(process.env.RUNNER_TEMP + "/sleeping", "");
while (!existsSync(process.env.RUNNER_TEMP + "/release-sleep")) await Bun.sleep(10);
`);
  chmodSync(join(dir, "sleep"), 0o755);
  const child = Bun.spawn(["bash", "-eo", "pipefail", "-c", `${region}\n${cooldown}\nbash "$GITHUB_ACTION_PATH/scripts/review-bun.sh" "$GITHUB_ACTION_PATH/scripts/log-mux.mjs" </dev/null`], {
    env, stdout: "pipe", stderr: "pipe", timeout: 5000,
  });
  setup.process = child;
  let output = "";
  const decoder = new TextDecoder();
  const stdout = (async () => {
    for await (const chunk of child.stdout) output += decoder.decode(chunk, { stream: true });
    output += decoder.decode();
  })();
  const stderr = new Response(child.stderr).text();
  const record = { event: "issue_comment", sender: { login: "alice" }, comment: { id: 1, body: "during cooldown 边界🙂\n".repeat(512) } };
  let offset = 0;
  try {
    await until(() => existsSync(join(dir, "sleeping")));
    appendFileSync(join(dir, "injected.log"), JSON.stringify(record) + "\n");
    await until(() => output.includes("::endgroup::"));
    offset = readFileSync(join(dir, "injected.rendered")).lastIndexOf(10) + 1;
    await until(() => offset > 0 && existsSync(join(dir, "injected.offset"))
      && Number(readFileSync(join(dir, "injected.offset"), "utf8")) === offset);
    expect(child.exitCode).toBeNull();
    const body = output.replace(/\x1b\[[0-9;]*m/g, "").match(/^::group::[^\n]*\n([\s\S]*?)^::endgroup::$/m)![1];
    expect(JSON.parse(body)).toEqual(record);
    expect(offset).toBeGreaterThan(0);
  } finally {
    writeFileSync(join(dir, "release-sleep"), "");
  }
  expect(await child.exited).toBe(0);
  await stdout;
  expect(await stderr).toBe("");
  expect(groupTitles(output)).toHaveLength(1);
  expect(Number(readFileSync(join(dir, "injected.offset"), "utf8"))).toBe(offset);
  expect(offset).toBe(readFileSync(join(dir, "injected.rendered")).length);
});

test.each([0, 7])("review log cleanup preserves exit code %i and drains its final row", code => {
  const { dir, env } = fixture();
  const source = readFileSync(join(import.meta.dir, "run-review.sh"), "utf8");
  const region = source.slice(source.indexOf(': > "$RUNNER_TEMP/injected.log"'), source.indexOf("trap finish_injected EXIT") + "trap finish_injected EXIT".length);
  // A reused runner can retain the previous review's spool and cursor.
  writeFileSync(join(dir, "injected.rendered"), "old activity\n".repeat(200));
  writeFileSync(join(dir, "injected.offset"), String(readFileSync(join(dir, "injected.rendered")).length));
  writeFileSync(join(dir, "records"), JSON.stringify(event(100, "last job", { workflow: "CI" })) + "\n");
  const result = Bun.spawnSync(["bash", "-eo", "pipefail", "-c", `${region}\ncat "$RUNNER_TEMP/records" >> "$RUNNER_TEMP/injected.log"\nexit ${code}`], { env, timeout: 3000 });
  expect(result.exitCode).toBe(code);
  expect(result.stdout.toString()).toContain("CI / last job:success");
  expect(result.stdout.toString()).not.toContain("old activity");
  expect(result.stdout.toString()).not.toContain("review_log_end");
  expect(groupTitles(result.stdout.toString())).toHaveLength(1);
  expect(Number(readFileSync(join(dir, "injected.offset"), "utf8"))).toBe(readFileSync(join(dir, "injected.rendered")).length);
  expect(() => process.kill(Number(readFileSync(join(dir, "tail.pid"), "utf8")), 0)).toThrow();
});

test("a failed end-marker write cannot hang cleanup or replace the review result", () => {
  const { dir, env } = fixture();
  const source = readFileSync(join(import.meta.dir, "run-review.sh"), "utf8");
  const region = source.slice(source.indexOf(': > "$RUNNER_TEMP/injected.log"'), source.indexOf("trap finish_injected EXIT") + "trap finish_injected EXIT".length);
  const result = Bun.spawnSync(["bash", "-eo", "pipefail", "-c", `${region}\nrm "$RUNNER_TEMP/injected.log"\nmkdir "$RUNNER_TEMP/injected.log"\nexit 7`], { env, timeout: 3000 });
  expect(result.exitCode).toBe(7);
  expect(result.stderr.toString()).toContain("Is a directory");
});
