import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const scripts = process.env.REVIEW_SCRIPTS_PATH || import.meta.dir;
const realJq = Bun.which("jq")!;
const realTail = Bun.which("tail")!;
const homes: string[] = [];
const human = { login: "collaborator", type: "User" };
const bot = { login: "ci[bot]", type: "Bot" };
const check = (overrides = {}) => ({ id: 100, name: "test", status: "completed", conclusion: "success", head_sha: "head", app: { slug: "github-actions" }, ...overrides });
const frame = (event: string, body: object, delivery = event, writer = true) => `id: ${delivery}\ndata: ${JSON.stringify({ event, delivery, writer, body: JSON.stringify({ sender: human, ...body }) })}\n\n`;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "review-events-"));
  homes.push(dir);
  writeFileSync(join(dir, "sse.jsonl"), "");
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, RUNNER_TEMP: dir, CODEX_HOME: dir, GITHUB_ACTION_PATH: root,
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

function runCI(responses: { pages?: object[]; error?: string }[], events = "", args: string[] = []) {
  const setup = fixture();
  writeFileSync(join(setup.dir, "sse.jsonl"), events);
  writeFileSync(join(setup.dir, "responses.json"), JSON.stringify(responses));
  executable(setup.dir, "gh", `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const dir = process.env.RUNNER_TEMP;
const argv = process.argv.slice(2);
appendFileSync(dir + "/gh-args", JSON.stringify(argv) + "\\n");
if (!argv.includes("--paginate") || !argv.includes("--slurp")) { console.error("missing pagination"); process.exit(1); }
const countFile = dir + "/calls";
const count = existsSync(countFile) ? Number(readFileSync(countFile, "utf8")) : 0;
writeFileSync(countFile, String(count + 1));
const response = JSON.parse(readFileSync(dir + "/responses.json", "utf8"))[count];
if (!response) { console.error("unexpected API call"); process.exit(1); }
if (response.pages) console.log(JSON.stringify(response.pages));
if (response.error) { console.error(response.error); process.exit(1); }
`);
  // Keep the actual jq evaluator: mocking its JSON output would hide broken filters.
  executable(setup.dir, "jq", `#!/usr/bin/env bash\nprintf 'called\\n' >> "$RUNNER_TEMP/jq-calls"\nexec '${realJq}' "$@"\n`);
  executable(setup.dir, "tail", `#!/usr/bin/env bash\nprintf '%s' "$$" > "$RUNNER_TEMP/tail-pid"\nexec '${realTail}' "$@"\n`);
  const result = Bun.spawnSync(["bash", join(scripts, "wait-ci.sh"), "head", ...args], { env: setup.env, timeout: 3000 });
  return { ...setup, result, calls: Number(readFileSync(join(setup.dir, "calls"), "utf8")) };
}

function expectTailReleased(dir: string) {
  const pid = Number(readFileSync(join(dir, "tail-pid"), "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
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

test("Stop excludes other heads, nonterminal CI, suites, its App and this workflow run", () => {
  const log = [
    frame("check_run", { action: "completed", check_run: check({ head_sha: "other" }) }, "other"),
    frame("check_run", { action: "created", check_run: check() }, "created"),
    frame("check_run", { action: "completed", check_run: check({ name: "codex-review" }) }, "review"),
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
  expect(JSON.parse(readFileSync(join(dir, "injected-deliveries.json"), "utf8"))).toEqual([]);
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

test("history plus pending replay is deduplicated within one Stop and across Stops", () => {
  const event = frame("issue_comment", { issue: { number: 7 }, comment: { body: "once-only" } }, "same-delivery");
  const { output, run, dir } = runHook(event + event);
  expect(output.match(/once-only/g)).toHaveLength(1);
  expect(run().stdout.toString()).toBe("");
  expect(JSON.parse(readFileSync(join(dir, "injected-deliveries.json"), "utf8"))).toEqual(["same-delivery"]);
});

test("CI wait paginates, excludes both owned IDs and only its own App review check", () => {
  const { result, dir, calls } = runCI([{ pages: [
    { check_runs: [check({ id: 10, status: "in_progress" }), check({ id: 11, status: "in_progress" }), check({ id: 12, name: "codex-review", app: { slug: "reviewer" }, status: "in_progress" })] },
    { check_runs: [check({ name: "codex-review", app: { slug: "other-reviewer" }, conclusion: "failure" }), check()] },
  ] }]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe("codex-review: failure\ntest: success\n");
  expect(calls).toBe(1);
  expect(existsSync(join(dir, "jq-calls"))).toBe(true);
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

test("TERM interrupts an event wait and reaps its tail child", async () => {
  const { dir, env } = fixture();
  executable(dir, "gh", "#!/usr/bin/env bash\nprintf '[{\"check_runs\":[]}]\\n'\n");
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
  executable(dir, "gh", "#!/usr/bin/env bash\nprintf '[{\"check_runs\":[]}]\\n'\n");
  executable(dir, "tail", '#!/usr/bin/env bash\nprintf "%s" "$$" > "$RUNNER_TEMP/tail-pid"\n');
  const result = Bun.spawnSync(["bash", join(scripts, "wait-ci.sh"), "head"], { env, timeout: 3000 });
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("CI event stream closed before checks completed");
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

test("the real subscription reconnects from the last complete delivery, not a truncated id", () => {
  const { dir, env } = fixture();
  const first = frame("status", { sha: "head", state: "success" }, "first");
  const second = frame("status", { sha: "head", state: "failure" }, "second");
  writeFileSync(join(dir, "response-0"), first + second.slice(0, -1));
  writeFileSync(join(dir, "response-1"), second);
  writeFileSync(join(dir, "response-2"), "");
  executable(dir, "curl", `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const dir = process.env.RUNNER_TEMP;
const log = dir + "/curl-calls";
const count = existsSync(log) ? readFileSync(log, "utf8").trim().split("\\n").length : 0;
appendFileSync(log, JSON.stringify(process.argv.slice(2)) + "\\n");
process.stdout.write(readFileSync(dir + "/response-" + count));
process.exit(28);
`);
  executable(dir, "seq", "#!/usr/bin/env bash\nprintf '1\\n2\\n3\\n'\n");
  executable(dir, "sleep", "#!/usr/bin/env bash\nexit 0\n");
  const action = Bun.YAML.parse(readFileSync(join(root, "action.yml"), "utf8")) as any;
  const subscription = action.runs.steps.find((step: any) => step.name === "Subscribe PR updates via SSE").run;
  mkdirSync(join(dir, "sessions"), { recursive: true });
  writeFileSync(join(dir, "sessions/.github-deliveries.json"), JSON.stringify(["dispatch"]));
  writeFileSync(join(dir, "event.json"), JSON.stringify({ action: "created", sender: { login: "collaborator", type: "User" } }));
  const result = Bun.spawnSync(["bash", "-c", subscription + '\nwait "$!"'], { env: { ...env, EVENTS_URL: "https://example.test/events?token=fixture", GITHUB_ENV: join(dir, "github-env"), GITHUB_EVENT_NAME: "issue_comment", GITHUB_EVENT_PATH: join(dir, "event.json"), ACTIVITY_ID: "seed", ACTIVITY_WRITER: "true" }, timeout: 3000 });
  expect(result.exitCode).toBe(0);
  const log = readFileSync(join(dir, "sse.jsonl"), "utf8");
  expect(log.startsWith("id: seed\nevent: issue_comment\ndata: {")).toBe(true);
  expect(log.endsWith(first + second)).toBe(true);
  const calls = readFileSync(join(dir, "curl-calls"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  for (const [i, delivery] of ["dispatch", "first", "second"].entries()) {
    expect(calls[i]).toContain(`Last-Event-ID: ${delivery}`);
    expect(calls[i]).toContain("https://example.test/events?token=fixture&pr=7&sha=head&run=12");
  }
});

test("the trigger webhook is seeded in the same shape the broker relays", () => {
  const { dir, env } = fixture();
  mkdirSync(join(dir, "sessions"), { recursive: true });
  writeFileSync(join(dir, "event.json"), JSON.stringify({ action: "created", sender: human, issue: { number: 7, pull_request: {} }, comment: { id: 1, body: "hi" } }));
  const body = Bun.spawnSync(["jq", "-c", ".", join(dir, "event.json")]).stdout.toString().trim();
  const delivery = Bun.spawnSync(["bash", "-c", 'printf %s "$0" | sha256sum | cut -c1-40', body]).stdout.toString().trim();
  executable(dir, "curl", "#!/usr/bin/env bash\nexit 28\n");
  executable(dir, "seq", "#!/usr/bin/env bash\nprintf '1\\n'\n");
  executable(dir, "sleep", "#!/usr/bin/env bash\nexit 0\n");
  const action = Bun.YAML.parse(readFileSync(join(root, "action.yml"), "utf8")) as any;
  const subscription = action.runs.steps.find((step: any) => step.name === "Subscribe PR updates via SSE").run;
  expect(subscription).toContain('| awk -f "$GITHUB_ACTION_PATH/scripts/sse-frames.awk"');
  expect(subscription).toContain("&sha=$HEAD_SHA&run=$GITHUB_RUN_ID");
  const result = Bun.spawnSync(["bash", "-c", subscription + '\nwait "$!"'], { env: { ...env, EVENTS_URL: "https://example.test/events?token=fixture", GITHUB_ENV: join(dir, "github-env"), GITHUB_EVENT_NAME: "issue_comment", GITHUB_EVENT_PATH: join(dir, "event.json"), ACTIVITY_ID: delivery, ACTIVITY_WRITER: "true" }, timeout: 3000 });
  expect(result.exitCode).toBe(0);
  const [id, event, data] = readFileSync(join(dir, "sse.jsonl"), "utf8").split("\n");
  expect(id).toBe(`id: ${delivery}`);
  expect(event).toBe("event: issue_comment");
  const parsed = JSON.parse(data.slice(6));
  expect(parsed.delivery).toBe(delivery);
  expect(parsed.event).toBe("issue_comment");
  expect(JSON.parse(parsed.body)).toEqual(JSON.parse(readFileSync(join(dir, "event.json"), "utf8")));
  expect(parsed.writer).toBe(true);
  const review = action.runs.steps.find((step: any) => step.name === "Run codex review");
  expect(review.env.JOB_CHECK_RUN_ID).toBe("${{ job.check_run_id }}");
  expect(review.env.ACTIVITY).toBeUndefined();
});

test("the action and the broker derive the same id from one webhook", () => {
  const { dir } = fixture();
  const payload = { action: "submitted", sender: { login: "collaborator", type: "User" }, pull_request: { number: 7, head: { sha: "head" } }, review: { id: 9, state: "commented", body: "looks good" } };
  writeFileSync(join(dir, "event.json"), JSON.stringify(payload, null, 2));
  const canonical = Bun.spawnSync(["jq", "-c", ".", join(dir, "event.json")]).stdout.toString().trim();
  expect(canonical).toBe(JSON.stringify(payload));
  type Crypto = { subtle: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> } };
  return (crypto as unknown as Crypto).subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(payload))).then((digest) => {
    const brokerId = [...new Uint8Array(digest).slice(0, 20)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const actionId = Bun.spawnSync(["bash", "-c", 'printf %s "$0" | sha256sum | cut -c1-40', canonical]).stdout.toString().trim();
    expect(actionId).toBe(brokerId);
  });
});

test("the activity that started this run is not reported back to it", () => {
  const head = frame("push", { ref: "refs/heads/feature", after: "head" });
  expect(runHook(head, { PR_NUMBER: "", HEAD_SHA: "head" }).output).toBe("");
  const midReview = frame("push", { ref: "refs/heads/feature", after: "later" });
  expect(runHook(midReview, { PR_NUMBER: "", HEAD_SHA: "head" }).output).toContain("later");
  const opened = frame("pull_request", { number: 7, action: "synchronize", pull_request: { number: 7 } });
  expect(runHook(opened).output).toBe("");
  const closed = frame("pull_request", { number: 7, action: "closed", pull_request: { number: 7, merged: true } });
  expect(runHook(closed).output).toContain("merged");
});

test("a run skips an event another review already consumed, and strangers", async () => {
  const action = Bun.YAML.parse(readFileSync(join(root, "action.yml"), "utf8")) as any;
  const gate = action.runs.steps.find((step: any) => step.name === "Skip activity another review already handled").run.replaceAll("${{ github.repository }}", "owner/repo").replaceAll("${{ runner.temp }}", "/tmp");
  const setup = fixture();
  mkdirSync(join(setup.dir, "sessions"), { recursive: true });
  writeFileSync(join(setup.dir, "event.json"), JSON.stringify({ action: "created", sender: human, issue: { number: 7, pull_request: {} }, comment: { id: 1 } }));
  const body = JSON.stringify(JSON.parse(readFileSync(join(setup.dir, "event.json"), "utf8")));
  const id = Bun.spawnSync(["bash", "-c", 'printf %s "$0" | sha256sum | cut -c1-40', body]).stdout.toString().trim();
  const run = (extra: Record<string, string> = {}) => {
    writeFileSync(join(setup.dir, "github-env"), "");
    const result = Bun.spawnSync(["bash", "-c", gate], { env: { ...setup.env, GITHUB_ENV: join(setup.dir, "github-env"), GITHUB_EVENT_NAME: "issue_comment", GITHUB_EVENT_PATH: join(setup.dir, "event.json"), ...extra }, timeout: 5000 });
    expect(result.exitCode).toBe(0);
    return readFileSync(join(setup.dir, "github-env"), "utf8");
  };
  executable(setup.dir, "gh", "#!/usr/bin/env bash\nprintf 'write\\n'\n");
  expect(run()).toContain("ACTIVITY_ID=");
  expect(run()).not.toContain("SKIP=true");
  expect(run()).toContain("ACTIVITY_WRITER=true");
  writeFileSync(join(setup.dir, "sessions/.github-deliveries.json"), JSON.stringify([id]));
  expect(run()).toContain("SKIP=true");
  writeFileSync(join(setup.dir, "sessions/.github-deliveries.json"), "[]");
  executable(setup.dir, "gh", "#!/usr/bin/env bash\nprintf 'read\\n'\n");
  expect(run()).toContain("SKIP=true");
});
