import { afterEach, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const realTail = Bun.which("tail")!;
const head = "c342a0e73079da37ef300f6ed1473d3ca63982b4";
const fixtures: { dir: string; process?: ReturnType<typeof Bun.spawn> }[] = [];
const event = (suite = 100, name = "check (windows, 3.12)", extra = {}) => ({ event: "check_run", action: "completed", actor: "dependabot[bot]", app: { name: "GitHub Actions", slug: "github-actions" }, check_suite_id: suite, head, name, conclusion: "success", ...extra });
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
  return { setup, dir, env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, RUNNER_TEMP: dir, GITHUB_ACTION_PATH: root, GITHUB_REPOSITORY: "owner/repo", GH_CONFIG_DIR: join(dir, "gh-config"), REVIEW_ACTIONS_TOKEN: "job-token", GH_TOKEN: "app-token", GITHUB_TOKEN: "", ...env } };
}

async function until(predicate: () => boolean, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for log worker");
    await Bun.sleep(10);
  }
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
  expect(log.output()).not.toContain("dependabot");
  expect(log.calls()).toEqual([{ argv: ["api", "repos/owner/repo/actions/runs?check_suite_id=100&per_page=1"], token: "job-token", config: log.env.GH_CONFIG_DIR, stdin: "" }]);
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
  expect(log.output()).not.toContain("::");
  expect(log.output()).not.toContain("##[");
});

test("CI log never looks up other providers, missing identities or a supplied workflow", async () => {
  const log = start();
  log.append(event(100, "Proof", { app: { name: "blacksmith.sh", slug: "blacksmith-sh" } }), event(100, "known", { workflow: "Build" }), event(-1, "invalid suite"), event(100, "missing head", { head: undefined }), { event: "issue_comment", actor: "alice" });
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
  log.append(event(200, "last job"), { event: "issue_comment", actor: "alice" });
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

test("only the log worker inherits the Actions lookup credential", () => {
  const { dir, env } = fixture({ 100: { body: run() } });
  const source = readFileSync(join(import.meta.dir, "run-review.sh"), "utf8");
  const region = source.slice(source.indexOf(': > "$RUNNER_TEMP/injected.log"'), source.indexOf("trap finish_injected EXIT") + "trap finish_injected EXIT".length);
  writeFileSync(join(dir, "records"), JSON.stringify(event()) + "\n");
  const result = Bun.spawnSync(["bash", "-eo", "pipefail", "-c", `${region}
cat "$RUNNER_TEMP/records" >> "$RUNNER_TEMP/injected.log"
for _ in {1..100}; do [ ! -s "$RUNNER_TEMP/calls" ] || break; sleep 0.02; done
bash -c 'test -z "\${REVIEW_ACTIONS_TOKEN+x}" && test "$GH_TOKEN" = app-token'
`], { env, timeout: 4000 });
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(readFileSync(join(dir, "calls"), "utf8")).token).toBe("job-token");
});

test.each([0, 7])("review log cleanup preserves exit code %i and drains its final row", code => {
  const { dir, env } = fixture();
  const source = readFileSync(join(import.meta.dir, "run-review.sh"), "utf8");
  const region = source.slice(source.indexOf(': > "$RUNNER_TEMP/injected.log"'), source.indexOf("trap finish_injected EXIT") + "trap finish_injected EXIT".length);
  writeFileSync(join(dir, "records"), JSON.stringify(event(100, "last job", { workflow: "CI" })) + "\n");
  const result = Bun.spawnSync(["bash", "-eo", "pipefail", "-c", `${region}\ncat "$RUNNER_TEMP/records" >> "$RUNNER_TEMP/injected.log"\nexit ${code}`], { env, timeout: 3000 });
  expect(result.exitCode).toBe(code);
  expect(result.stdout.toString()).toContain("CI / last job:success");
  expect(result.stdout.toString()).not.toContain("review_log_end");
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
