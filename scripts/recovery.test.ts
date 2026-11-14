import { afterEach, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const steps = Bun.YAML.parse(readFileSync(join(root, "action.yml"), "utf8")).runs.steps;
const step = (name: string) => steps.find((entry: any) => entry.name === name);
const homes: string[] = [];
const writer = { login: "writer", type: "User" };
const comment = { action: "created", sender: writer, issue: { number: 7, pull_request: {} }, comment: { id: 1 } };
const delivery = new Bun.CryptoHasher("sha256").update("issue_comment:created:1::").digest("hex").slice(0, 40);

function fixture(event: object = comment) {
  const dir = mkdtempSync(join(tmpdir(), "review-recovery-"));
  homes.push(dir);
  mkdirSync(join(dir, "sessions"));
  for (const file of ["github-env", "sse.jsonl", "check-runs.jsonl"]) writeFileSync(join(dir, file), "");
  writeFileSync(join(dir, "event.json"), JSON.stringify(event));
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, RUNNER_TEMP: dir, CODEX_HOME: dir, GITHUB_ACTION_PATH: root,
    GITHUB_REPOSITORY: "owner/repo", GITHUB_REPOSITORY_ID: "23", GITHUB_ENV: join(dir, "github-env"), GITHUB_OUTPUT: join(dir, "github-output"),
    GITHUB_EVENT_PATH: join(dir, "event.json"), GITHUB_EVENT_NAME: "issue_comment", MODEL_NAME: "deepseek-flash", SESSION_KEY: "pr-7",
    PR_NUMBER: "7", HEAD_SHA: "head", BOT_LOGIN: "reviewer[bot]", PR_AUTHOR: "writer", GITHUB_RUN_ID: "12", GITHUB_WORKFLOW: "review", GITHUB_SERVER_URL: "https://github.com",
    EYES_REACTION_ID: "", EYES_REACTION_PATH: "" };
  return { dir, env };
}

function executable(dir: string, name: string, source: string) {
  writeFileSync(join(dir, name), source);
  chmodSync(join(dir, name), 0o755);
}

function run(name: string, setup: ReturnType<typeof fixture>, extraEnv: Record<string, string> = {}) {
  const script = step(name).run.replaceAll("${{ github.repository }}", "owner/repo").replaceAll("${{ runner.temp }}", setup.dir)
    .replaceAll("${{ github.event.repository.default_branch }}", "main").replaceAll("${{ steps.check.outputs.id }}", "10").replaceAll("${{ github.token }}", "token").replace(/\$\{\{[^}]+\}\}/g, "");
  return Bun.spawnSync(["bash", "-eo", "pipefail", "-c", script], { env: { ...setup.env, ...extraEnv }, timeout: 3000 });
}

function gate(setup: ReturnType<typeof fixture>, extraEnv: Record<string, string> = {}) {
  writeFileSync(join(setup.dir, "github-env"), "");
  const result = run("Skip activity another review already handled", setup, extraEnv);
  expect(result.exitCode).toBe(0);
  return readFileSync(join(setup.dir, "github-env"), "utf8");
}

afterEach(() => { for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("queued PR webhooks resolve the current head while retaining their original activity", () => {
  for (const kind of ["pull_request_target", "pull_request_review"]) {
    const setup = fixture({ action: "synchronize", sender: writer, pull_request: { number: 7, head: { sha: "old" } } });
    const fresh = { number: 7, head: { sha: "new", ref: "feature", repo: { full_name: "owner/repo" } }, base: { ref: "main" }, user: writer };
    executable(setup.dir, "gh", `#!/bin/sh\n[ "$*" = "api repos/owner/repo/pulls/7" ] || exit 1\nprintf '%s' '${JSON.stringify(fresh)}'\n`);
    const before = readFileSync(join(setup.dir, "event.json"), "utf8");
    expect(run("Resolve the review target", setup, { GITHUB_EVENT_NAME: kind, CODEX_CONFIG: 'model = "deepseek-flash"' }).exitCode).toBe(0);
    expect(readFileSync(join(setup.dir, "github-env"), "utf8")).toContain("HEAD_SHA=new\n");
    expect(readFileSync(join(setup.dir, "github-env"), "utf8")).toContain("MODEL_NAME=deepseek-flash\n");
    expect(readFileSync(join(setup.dir, "github-env"), "utf8")).not.toContain("SKIP=true");
    expect(readFileSync(join(setup.dir, "event.json"), "utf8")).toBe(before);
  }
});

test("a dispatch names its target, and an issue stays in the issue session group", () => {
  const setup = fixture({});
  executable(setup.dir, "gh", `#!/bin/sh
case "$*" in
  "api repos/owner/repo/issues/9"*) printf '%s' false ;;
  "api repos/owner/repo/commits/main"*) printf '%s' 'basesha' ;;
  *) exit 1 ;;
esac`);
  const dispatch = (env: Record<string, string>) => run("Resolve the review target", setup, { GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF_NAME: "feature", CODEX_CONFIG: 'model = "deepseek-flash"', SESSION_KEY: "", ...env });
  expect(dispatch({ DISPATCHED_ISSUE: "9" }).exitCode).toBe(0);
  const env = readFileSync(join(setup.dir, "github-env"), "utf8");
  expect(env).toContain("AGENT=true\nISSUE_NUMBER=9\n");
  expect(env).toContain("SESSION_KEY=issue-9\n");
  // The agent works on the default branch, whatever ref the dispatch ran on.
  expect(env).toContain("HEAD_SHA=basesha\nHEAD_BRANCH=main\nBASE=main\n");
  // Keep a valid issue response here so removing the two-target guard makes this fail.
  expect(dispatch({ DISPATCHED_PR: "7", DISPATCHED_ISSUE: "9" }).exitCode).not.toBe(0);
  // A pull request reaches its own group, so the issue input refuses one instead of forking the session.
  writeFileSync(join(setup.dir, "github-env"), "");
  executable(setup.dir, "gh", `#!/bin/sh\nprintf '%s' true`);
  expect(dispatch({ DISPATCHED_ISSUE: "9" }).exitCode).not.toBe(0);
  expect(readFileSync(join(setup.dir, "github-env"), "utf8")).not.toContain("AGENT=true");
});

test.each(["DISPATCHED_PR", "DISPATCHED_ISSUE"])("%s rejects noncanonical numbers before querying the API", (input) => {
  const setup = fixture({});
  executable(setup.dir, "gh", `#!/bin/sh\necho called >> "$RUNNER_TEMP/api-called"\nprintf '%s' '{"number":7,"head":{"sha":"head","ref":"feature","repo":{"full_name":"owner/repo"}},"base":{"ref":"main"},"user":{"login":"writer"}}'`);
  for (const number of ["07", "0", "-7", "7 ", "7\n"]) {
    const result = run("Resolve the review target", setup, { GITHUB_EVENT_NAME: "workflow_dispatch", SESSION_KEY: "", DISPATCHED_PR: "", DISPATCHED_ISSUE: "", [input]: number });
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(join(setup.dir, "api-called"))).toBe(false);
    expect(readFileSync(join(setup.dir, "github-env"), "utf8")).toBe("");
  }
});

test("identity and seeding follow the webhook event, not the workflow event", () => {
  for (const [event, expected] of [["pull_request_target", "pull_request"], ["pull_request_review", "pull_request_review"]]) {
    const setup = fixture({ action: "submitted", review: { id: 5, submitted_at: "now" }, pull_request: { number: 7, head: { sha: "head" } } });
    expect(gate(setup, { GITHUB_EVENT_NAME: event })).toContain(`EVENT_NAME=${expected}\n`);
  }
});

test("successive edits on an unchanged head get distinct activity ids", () => {
  const idFor = (body: string, updated: string) => {
    const setup = fixture({ action: "edited", sender: writer, number: 7, pull_request: { number: 7, title: "Title", body, updated_at: updated, head: { sha: "head" } } });
    return /ACTIVITY_ID=(\w+)/.exec(gate(setup, { GITHUB_EVENT_NAME: "pull_request_target" }))![1];
  };
  expect(idFor("A", "T1")).not.toBe(idFor("B", "T2"));
  // Restoring earlier text is still a later edit, not the original activity.
  expect(idFor("A", "T3")).not.toBe(idFor("A", "T1"));
  expect(idFor("A", "T1")).toBe(idFor("A", "T1"));
});

test("a synchronize retry requires a published checkpoint, including for older caches", () => {
  const setup = fixture({ action: "synchronize", pull_request: { number: 7, head: { sha: "old" } } });
  expect(gate(setup, { GITHUB_EVENT_NAME: "pull_request_target" })).not.toContain("SKIP=true");
  writeFileSync(join(setup.dir, "sessions/.github-published-head"), "old\n");
  expect(gate(setup, { GITHUB_EVENT_NAME: "pull_request_target" })).not.toContain("SKIP=true");
  writeFileSync(join(setup.dir, "sessions/.github-published-head"), "head\n");
  expect(gate(setup, { GITHUB_EVENT_NAME: "pull_request_target" })).toContain("SKIP=true");
});

test("every publication precedes checkpointing and snapshot upload, while merge waits follow it", () => {
  const index = (name: string) => steps.indexOf(step(name));
  const checkpoint = index("Checkpoint published review"), save = index("Save codex session");
  for (const name of ["Publish check run", "Publish other commit verdicts", "Publish PR review", "Finish PR reactions", "Write review summary"]) expect(index(name)).toBeLessThan(checkpoint);
  expect(checkpoint).toBeLessThan(save);
  expect(save).toBeLessThan(index("Merge PR"));
  expect(step("Checkpoint published review").if).not.toMatch(/always\(|failure\(/);
  expect(step("Save codex session").if).not.toMatch(/always\(|failure\(/);
  expect(step("Save codex session")["continue-on-error"]).toBe(true);
  expect(step("Drop older session snapshots").if).toBe("steps.save-session.outputs.artifact-id");
  // A failed publication skips the snapshot, but earlier saved drafts can still be released.
  expect(step("Mark forked PRs ready").if).toBe("always()");
});

function sessionSnapshots() {
  const setup = fixture(), artifacts = join(setup.dir, "artifacts.json"), output = join(setup.dir, "github-output");
  executable(setup.dir, "sleep", "#!/bin/sh\nexit 0\n");
  executable(setup.dir, "gh", `#!${process.execPath}
const [command, endpoint, ...args] = process.argv.slice(2);
if (endpoint.includes("collaborators")) { console.log("write"); process.exit(0); }
const path = process.env.RUNNER_TEMP + "/artifacts.json", artifacts = await Bun.file(path).json();
if (command !== "api" || process.env.GH_TOKEN !== "token" || !endpoint.startsWith("repos/owner/repo/actions/artifacts")) process.exit(1);
if (args.includes("GET")) {
  const name = args.find(arg => arg.startsWith("name=")).slice(5);
  if (process.env.FAIL_LIST === name) process.exit(1);
  console.log(JSON.stringify({ artifacts: artifacts.filter(artifact => artifact.name === name) }));
} else {
  const id = Number(endpoint.split("/").at(-1)), found = artifacts.find(artifact => artifact.id === id);
  if (!found) process.exit(1);
  if (args.includes("DELETE")) await Bun.write(path, JSON.stringify(artifacts.filter(artifact => artifact.id !== id)));
  else console.log(JSON.stringify(found));
}
`);
  writeFileSync(artifacts, "[]");
  const lookup = (runId: string, extraEnv: Record<string, string> = {}) => {
    writeFileSync(output, "");
    expect(run("Find codex session snapshot", setup, { GH_TOKEN: "token", GITHUB_RUN_ID: runId, ...extraEnv }).exitCode).toBe(0);
    return Object.fromEntries(readFileSync(output, "utf8").trimEnd().split("\n").map(line => line.split("=")));
  };
  const cleanup = (id: number, extraEnv: Record<string, string> = {}) => run("Drop older session snapshots", setup, { GH_TOKEN: "token", SNAPSHOT_ID: String(id), ...extraEnv });
  const artifact = (id: number, name: string, runId: number, second: number, repo = 23, expired = false) =>
    ({ id, name, expired, created_at: `2026-11-13T00:00:${String(second).padStart(2, "0")}Z`, workflow_run: { id: runId, head_repository_id: repo } });
  return { setup, lookup, cleanup, artifact,
    write: (entries: ReturnType<typeof artifact>[]) => writeFileSync(artifacts, JSON.stringify(entries)),
    read: () => JSON.parse(readFileSync(artifacts, "utf8")) };
}

test("main → merge ref → main restores the latest complete snapshot before deduplication", () => {
  const { setup, lookup, cleanup, artifact, write, read } = sessionSnapshots();
  const restore = "Restore codex session";
  const snapshotPaths = step("Save codex session").with.path.trim().split("\n").map((path: string) => path.split("/").at(-1));
  expect(snapshotPaths).toEqual(["sessions", "last-thread-id", "check-runs.jsonl"]);
  expect(step("Save codex session").with["include-hidden-files"]).toBe(true);
  expect(step(restore).with["artifact-ids"]).toBe("${{ steps.snapshot.outputs.id }}");
  expect(step("Restore legacy session cache").if).toContain("!steps.snapshot.outputs.id");
  expect(steps.indexOf(step(restore))).toBeLessThan(steps.indexOf(step("Skip activity another review already handled")));
  const main = { GITHUB_REF: "refs/heads/main" }, merge = { GITHUB_REF: "refs/pull/7/merge" };
  const first = lookup("10", main);
  expect(first.id).toBe("");
  expect(run("Find codex session snapshot", setup, { GH_TOKEN: "token", FAIL_LIST: first.name }).exitCode).not.toBe(0);
  const initial = artifact(20, first.name, 10, 10), orphan = artifact(19, first.name + "-next", 9, 9), review = artifact(11, first.name, 11, 11);
  const other = artifact(12, first.name + "-other", 12, 10), fork = artifact(13, first.name, 13, 10, 24), expired = artifact(14, first.name, 14, 10, 23, true);
  write([initial, orphan, other]);
  expect(lookup("11", merge)).toEqual({ id: "20", "run-id": "10", name: first.name });
  expect(cleanup(11).exitCode).not.toBe(0);
  expect(read()).toEqual([initial, orphan, other]);
  write([initial, orphan, review, other, fork, expired]);
  expect(cleanup(11, { FAIL_LIST: first.name + "-next" }).exitCode).not.toBe(0);
  expect(read()).toEqual([initial, orphan, review, other, fork, expired]);
  expect(cleanup(11).exitCode).toBe(0);
  expect(read()).toEqual([review, other, fork, expired]);
  expect(lookup("12", main)).toEqual({ id: "11", "run-id": "11", name: first.name });
  expect(lookup("12", { ...main, SESSION_KEY: "pr-8" }).id).toBe("");
  expect(lookup("12", { ...main, MODEL_NAME: "another-model" }).id).toBe("");

  // Emulate the download of the selected snapshot into a fresh runner home.
  writeFileSync(join(setup.dir, "last-thread-id"), "shared-thread\n");
  writeFileSync(join(setup.dir, "check-runs.jsonl"), '{"sha":"head"}\n');
  writeFileSync(join(setup.dir, "sessions/.github-published-head"), "head\n");
  writeFileSync(join(setup.dir, "sessions/.github-deliveries.json"), JSON.stringify([delivery]));
  expect(gate(setup, main)).toContain("SKIP=true");
});

test("attempts 2 and 3 alternate slots and keep the last snapshot until its replacement is visible", () => {
  const { lookup, cleanup, artifact, write, read } = sessionSnapshots();
  const runId = "10", primary = lookup(runId).name, alternate = primary + "-next";
  const first = artifact(20, primary, 10, 10), second = artifact(19, alternate, 10, 11), third = artifact(18, primary, 10, 12);
  expect(step("Save codex session").with).toMatchObject({ name: "${{ steps.snapshot.outputs.name }}", overwrite: true });
  write([first]);
  expect(lookup(runId, { GITHUB_RUN_ATTEMPT: "2" })).toEqual({ id: "20", "run-id": runId, name: alternate });
  expect(cleanup(second.id).exitCode).not.toBe(0);
  expect(read()).toEqual([first]);
  write([first, second]);
  expect(cleanup(second.id).exitCode).toBe(0);
  expect(read()).toEqual([second]);
  expect(lookup(runId, { GITHUB_RUN_ATTEMPT: "3" })).toEqual({ id: "19", "run-id": runId, name: primary });
  expect(cleanup(third.id).exitCode).not.toBe(0);
  expect(read()).toEqual([second]);
  write([second, third]);
  expect(cleanup(third.id).exitCode).toBe(0);
  expect(read()).toEqual([third]);
  expect(lookup("11").id).toBe("18");
});

test("a fork retries the download only after the opener prunes its selected snapshot", () => {
  const { setup, lookup, cleanup, artifact, write, read } = sessionSnapshots();
  const find = "Find a replacement session to fork", restore = "Restore the replacement session to fork";
  const source = { SESSION_KEY: "pr-6" };
  const name = lookup("10", source).name;
  const old = artifact(20, name, 10, 10), next = artifact(19, name + "-next", 11, 11);
  const output = join(setup.dir, "github-output");
  expect(step("Restore the session to fork")["continue-on-error"]).toBe(true);
  expect(step(find).if).toBe("steps.restore-fork.outcome == 'failure'");
  expect(step(restore).with).toMatchObject({
    "artifact-ids": "${{ steps.fork-replacement.outputs.id }}", "run-id": "${{ steps.fork-replacement.outputs.run-id }}",
    path: "${{ env.CODEX_HOME }}/fork",
  });
  expect(step("Run codex review").env.FORK_KEY).toContain("steps.restore-fork-replacement.outcome == 'success'");
  write([old]);
  expect(lookup("12", source).id).toBe("20");
  const retry = () => {
    writeFileSync(output, "");
    return run(find, setup, { GH_TOKEN: "token", FORK_KEY: "pr-6", REPLACE_SNAPSHOT_ID: "20" });
  };
  expect(retry().exitCode).not.toBe(0);
  write([old, next]);
  expect(retry().exitCode).not.toBe(0);
  expect(read()).toEqual([old, next]);
  expect(cleanup(next.id, source).exitCode).toBe(0);
  expect(read()).toEqual([next]);
  mkdirSync(join(setup.dir, "fork"));
  expect(retry().exitCode).toBe(0);
  expect(readFileSync(output, "utf8")).toContain("id=19\nrun-id=11\n");
  expect(existsSync(join(setup.dir, "fork"))).toBe(false);
});

test("hook receipts survive publication and restore from the cached JSON format", () => {
  const setup = fixture();
  executable(setup.dir, "gh", "#!/bin/sh\nprintf 'write\\n'\n");
  writeFileSync(join(setup.dir, "sessions/.github-deliveries.json"), JSON.stringify(["cached-event"]));
  const frame = (id: string, body: string) => `data: ${JSON.stringify({ event: "issue_comment", delivery: id, writer: true, body: JSON.stringify({ ...comment, comment: { body } }) })}\n\n`;
  writeFileSync(join(setup.dir, "sse.jsonl"), frame("cached-event", "already handled") + frame(delivery, "fresh activity"));
  const review = step("Run codex review").run;
  const restore = review.slice(review.indexOf("# Seed the hook receipts"), review.indexOf('if [ "$AGENT" = true ]; then'));
  const initialize = () => Bun.spawnSync(["bash", "-ec", restore], { env: setup.env });
  expect(initialize().exitCode).toBe(0);
  const hook = () => Bun.spawnSync(["bash", join(root, "scripts/review-hook.sh")], { env: setup.env, stdin: Buffer.from('{"hook_event_name":"Stop"}') });
  const output = hook();
  expect(output.exitCode).toBe(0);
  expect(output.stdout.toString()).not.toContain("already handled");
  expect(output.stdout.toString()).toContain("fresh activity");
  // Parallel rounds may append duplicate receipts; the cache retains distinct deliveries.
  const receipts = join(setup.dir, "injected-deliveries.log");
  writeFileSync(receipts, readFileSync(receipts, "utf8") + delivery + "\n");
  expect(run("Checkpoint published review", setup).exitCode).toBe(0);
  expect(JSON.parse(readFileSync(join(setup.dir, "sessions/.github-deliveries.json"), "utf8"))).toEqual(["cached-event", delivery]);
  expect(gate(setup)).toContain("SKIP=true");
  rmSync(receipts);
  expect(initialize().exitCode).toBe(0);
  expect(hook().stdout.toString()).toBe("");
});

for (const failed of ["Publish check run", "Publish other commit verdicts", "Publish PR review", ""]) {
  test(`publication ${failed ? `failure in ${failed} stays replayable` : "success checkpoints consumed activity"}`, () => {
    const setup = fixture();
    const path = (file: string) => join(setup.dir, file);
    executable(setup.dir, "git", "#!/bin/sh\nprintf 'head\\n'\n");
    executable(setup.dir, "sleep", "#!/bin/sh\nexit 0\n");
    executable(setup.dir, "gh", `#!/bin/sh
if [ "$FAIL_STAGE" = "$STAGE" ] && [ -n "$STAGE" ]; then exit 1; fi
case "$*" in
  *collaborators*) printf 'write\\n' ;;
  *'/reviews?'*|*'/files?'*) printf '[]\\n' ;;
  *'--jq .total_count'*) printf '0\\n' ;;
  *) cat > /dev/null; printf '{}\\n' ;;
esac
`);
    writeFileSync(path("review.json"), JSON.stringify({ conclusion: "success", summary: "Reviewed", commits: [{ sha: "head", conclusion: "success" }, { sha: "child", conclusion: "success" }], annotations: [] }));
    writeFileSync(path("injected-deliveries.log"), delivery + "\n");
    let completed = true;
    for (const stage of ["Publish check run", "Publish other commit verdicts", "Publish PR review"]) {
      const result = run(stage, setup, { STAGE: stage, FAIL_STAGE: failed });
      if (result.exitCode !== 0) { expect(stage).toBe(failed); completed = false; break; }
    }
    if (completed) expect(run("Checkpoint published review", setup).exitCode).toBe(0);
    expect(completed).toBe(!failed);
    expect(existsSync(path("sessions/.github-deliveries.json"))).toBe(!failed);
    expect(gate(setup).includes("SKIP=true")).toBe(!failed);
    if (!failed) {
      expect(existsSync(path("sessions/.github-cursor"))).toBe(false);
      expect(gate(setup, { HEAD_SHA: "new" })).not.toContain("SKIP=true");
    }
  });
}

test("success reviews keep useful text and omit empty comments", () => {
  const text = "Disabling built-in filtering also disables DOM sorting for custom items.";
  const earlier = [{ user: { login: "reviewer[bot]" }, state: "COMMENTED", body: text }];
  for (const [author, reviews, summary, expected] of [
    ["writer", [], text, { event: "APPROVE", body: text }],
    ["writer", [], "", { event: "APPROVE" }],
    ["writer", [], " \n", { event: "APPROVE" }],
    ["reviewer[bot]", [], text, { event: "COMMENT", body: text }],
    ["reviewer[bot]", earlier, text, null],
    ["reviewer[bot]", [], "", null],
    ["reviewer[bot]", earlier, " \n", null],
  ] as const) {
    const setup = fixture();
    executable(setup.dir, "git", "#!/bin/sh\nprintf 'head\\n'\n");
    executable(setup.dir, "gh", `#!/bin/sh
case "$*" in
  *'/reviews?'*) printf '%s\\n' '${JSON.stringify(reviews)}' ;;
  *'/files?'*) printf '[]\\n' ;;
  *'/reviews --input'*) while [ $# -gt 1 ]; do shift; done; cp "$1" "$RUNNER_TEMP/posted.json" ;;
  *) cat > /dev/null; printf '{}\\n' ;;
esac
`);
    writeFileSync(join(setup.dir, "review.json"), JSON.stringify({ conclusion: "success", summary, annotations: [] }));
    expect(run("Publish PR review", setup, { PR_AUTHOR: author }).exitCode).toBe(0);
    const posted = existsSync(join(setup.dir, "posted.json")) ? JSON.parse(readFileSync(join(setup.dir, "posted.json"), "utf8")) : null;
    expect(posted).toEqual(expected);
  }
});

test("a failure review does not reopen a thread an unresolved review already covers", () => {
  for (const [resolved, line, login, posted] of [[false, 12, "reviewer", false], [false, null, "reviewer", false], [true, 12, "reviewer", true], [false, 13, "reviewer", true], [false, 12, "another-reviewer", true]] as const) {
    const setup = fixture();
    executable(setup.dir, "git", "#!/bin/sh\nprintf 'head\\n'\n");
    executable(setup.dir, "gh", `#!/bin/sh
case "$*" in
  *'/reviews?'*) printf '[]\\n' ;;
  *'/files?'*) printf '%s\\n' '{"a.py":[[10,14]]}' ;;
  *'api graphql'*) printf '%s\\n' '{"data":{"repository":{"pullRequest":{"reviewThreads":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[{"isResolved":${resolved},"path":"a.py","line":${line},"comments":{"nodes":[{"author":{"login":"${login}"},"body":"Boom"}]}}]}}}}}' ;;
  *'/reviews --input'*) while [ $# -gt 1 ]; do shift; done; cp "$1" "$RUNNER_TEMP/posted.json" ;;
  *) cat > /dev/null; printf '{}\\n' ;;
esac
`);
    writeFileSync(join(setup.dir, "review.json"), JSON.stringify({ conclusion: "failure", summary: "", annotations: [{ path: "a.py", line: 12, level: "failure", message: "Boom" }] }));
    expect(run("Publish PR review", setup).exitCode).toBe(0);
    const published = join(setup.dir, "posted.json");
    expect(existsSync(published)).toBe(posted);
    if (posted) expect(JSON.parse(readFileSync(published, "utf8")).comments).toHaveLength(1);
  }
});

test("snapshot upload failure restores the previous checkpoint and replays newer activity", () => {
  const setup = fixture();
  executable(setup.dir, "gh", "#!/bin/sh\nprintf 'write\\n'\n");
  writeFileSync(join(setup.dir, "sessions/.github-deliveries.json"), "[]");
  writeFileSync(join(setup.dir, "sessions/.github-published-head"), "old\n");
  cpSync(join(setup.dir, "sessions"), join(setup.dir, "saved"), { recursive: true });
  writeFileSync(join(setup.dir, "injected-deliveries.log"), delivery + "\n");
  expect(run("Checkpoint published review", setup).exitCode).toBe(0);
  expect(gate(setup)).toContain("SKIP=true");
  // A failed upload leaves the previous cache intact; a later runner restores only that snapshot.
  rmSync(join(setup.dir, "sessions"), { recursive: true });
  cpSync(join(setup.dir, "saved"), join(setup.dir, "sessions"), { recursive: true });
  expect(gate(setup)).not.toContain("SKIP=true");
});

test("a handoff cannot checkpoint an intermediate verdict as the successor's annotated review", () => {
  const setup = fixture();
  writeFileSync(join(setup.dir, "sessions/.github-published-head"), "old\n");
  writeFileSync(join(setup.dir, "injected-deliveries.log"), "");
  expect(run("Checkpoint published review", setup, { SUPERSEDED: "true" }).exitCode).toBe(0);
  expect(existsSync(join(setup.dir, "sessions/.github-published-head"))).toBe(false);
});

test("publication detects a head that moved after the last SSE frame", () => {
  for (const hasRun of [true, false]) {
    const setup = fixture();
    executable(setup.dir, "git", "#!/bin/sh\nprintf 'head\\n'\n");
    executable(setup.dir, "gh", `#!/bin/sh
case "$*" in
  *'/pulls/7 --jq .head.sha') printf 'newer\\n' ;;
  *'/actions/runs?head_sha=newer'*) printf '${hasRun}\\n' ;;
  *'/compare/head...newer'*) printf 'ahead\\n' ;;
  *'/check-runs/10 -X PATCH'*) cat > "$RUNNER_TEMP/published.json" ;;
  *) exit 1 ;;
esac
`);
    writeFileSync(join(setup.dir, "review.json"), JSON.stringify({ summary: "Reviewed", commits: [{ sha: "head", conclusion: "success" }], annotations: [] }));
    const result = run("Publish check run", setup);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().includes("A subsequent review run is needed for that head.")).toBe(!hasRun);
    expect(readFileSync(join(setup.dir, "github-env"), "utf8").includes("SUPERSEDED=true")).toBe(hasRun);
    expect(JSON.parse(readFileSync(join(setup.dir, "published.json"), "utf8")).conclusion).toBe(hasRun ? "neutral" : "success");
  }
});

test("a failed final head refresh preserves the verdict and reports the missing reconciliation", () => {
  const setup = fixture();
  executable(setup.dir, "git", "#!/bin/sh\nprintf 'head\\n'\n");
  executable(setup.dir, "sleep", "#!/bin/sh\nexit 0\n");
  executable(setup.dir, "gh", `#!/bin/sh
case "$*" in
  *'/pulls/7 --jq .head.sha') exit 1 ;;
  *'/check-runs/10 -X PATCH'*) cat > "$RUNNER_TEMP/published.json" ;;
  *) exit 1 ;;
esac
`);
  writeFileSync(join(setup.dir, "review.json"), JSON.stringify({ summary: "Reviewed", commits: [{ sha: "head", conclusion: "success" }], annotations: [] }));
  const result = run("Publish check run", setup);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("Could not refresh PR #7 before publication.");
  expect(JSON.parse(readFileSync(join(setup.dir, "published.json"), "utf8")).conclusion).toBe("success");
});

test("a failed publication releases only drafts an earlier run left pending", () => {
  const setup = fixture();
  writeFileSync(join(setup.dir, "forked-prs"), "https://github.com/owner/repo/pull/8\n");
  writeFileSync(join(setup.dir, "sessions/.github-pending-drafts"), "https://github.com/owner/repo/pull/9\n");
  executable(setup.dir, "gh", '#!/bin/sh\n[ "$1 $2" = "pr ready" ] || exit 1\necho "$3" >> "$RUNNER_TEMP/ready"\n');
  const result = run("Mark forked PRs ready", setup, { SNAPSHOT_ID: "" });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("stay draft");
  expect(readFileSync(join(setup.dir, "ready"), "utf8")).toBe("https://github.com/owner/repo/pull/9\n");
  // The draft this run opened has no saved source session, so it stays draft for a manual release.
  expect(existsSync(join(setup.dir, "sessions/.github-pending-drafts"))).toBe(false);
});

test.each([
  ["", { SNAPSHOT_ID: "" }, false],
  ["forked-prs", { SNAPSHOT_ID: "27" }, true],
  ["sessions/.github-pending-drafts", { SNAPSHOT_ID: "" }, true],
])("draft release accepts optional lists: %s", (file, extra, released) => {
  const setup = fixture(), url = "https://github.com/owner/repo/pull/8";
  if (file) writeFileSync(join(setup.dir, file), `${url}\n`);
  executable(setup.dir, "gh", `#!/bin/sh
case "$*" in
  *actions/artifacts/27*) echo true ;;
  "pr ready "*) echo "$3" >> "$RUNNER_TEMP/ready" ;;
  *) exit 1 ;;
esac
`);
  expect(run("Mark forked PRs ready", setup, extra as Record<string, string>).exitCode).toBe(0);
  expect(existsSync(join(setup.dir, "ready"))).toBe(released);
});

test("new draft handoffs preserve pending drafts restored from the session", () => {
  const setup = fixture();
  writeFileSync(join(setup.dir, "forked-prs"), "https://github.com/owner/repo/pull/8\n");
  writeFileSync(join(setup.dir, "sessions/.github-pending-drafts"), "https://github.com/owner/repo/pull/9\n");
  const commands = step("Run codex review").run.slice(step("Run codex review").run.lastIndexOf('mkdir -p "$CODEX_HOME/sessions"'));
  expect(Bun.spawnSync(["bash", "-eo", "pipefail", "-c", commands], { env: { ...setup.env, AGENT: "true" } }).exitCode).toBe(0);
  executable(setup.dir, "gh", `#!/bin/sh
case "$*" in
  *actions/artifacts/27*) echo true ;;
  "pr ready "*) echo "$3" >> "$RUNNER_TEMP/ready" ;;
  *) exit 1 ;;
esac
`);
  expect(run("Mark forked PRs ready", setup, { SNAPSHOT_ID: "27" }).exitCode).toBe(0);
  expect(readFileSync(join(setup.dir, "ready"), "utf8")).toBe("https://github.com/owner/repo/pull/8\nhttps://github.com/owner/repo/pull/9\n");
});

test("a consumed retry still releases its cached pending drafts", () => {
  const setup = fixture();
  executable(setup.dir, "gh", '#!/bin/sh\ncase "$*" in\n  *collaborators*) printf "write\\n" ;;\n  "pr ready "*) echo "$3" >> "$RUNNER_TEMP/ready" ;;\n  *) exit 1 ;;\nesac\n');
  writeFileSync(join(setup.dir, "sessions/.github-deliveries.json"), JSON.stringify([delivery]));
  writeFileSync(join(setup.dir, "sessions/.github-published-head"), "head\n");
  writeFileSync(join(setup.dir, "sessions/.github-pending-drafts"), "https://github.com/owner/repo/pull/8\n");
  expect(gate(setup)).toContain("SKIP=true");
  expect(step("Mark forked PRs ready").if).toBe("always()");
  expect(run("Mark forked PRs ready", setup, { SKIP: "true", SNAPSHOT_ID: "" }).exitCode).toBe(0);
  expect(readFileSync(join(setup.dir, "ready"), "utf8")).toBe("https://github.com/owner/repo/pull/8\n");
});

test("a draft stays draft when the saved session is not listed", () => {
  const setup = fixture();
  writeFileSync(join(setup.dir, "forked-prs"), "https://github.com/owner/repo/pull/8\n");
  executable(setup.dir, "gh", `#!/bin/sh
case "$*" in
  *actions/artifacts/27*) echo false ;;
  "pr ready "*) echo "$3" >> "$RUNNER_TEMP/ready" ;;
  *) exit 1 ;;
esac
`);
  expect(run("Mark forked PRs ready", setup, { SNAPSHOT_ID: "27" }).exitCode).toBe(0);
  expect(existsSync(join(setup.dir, "ready"))).toBe(false);
  expect(readFileSync(join(setup.dir, "forked-prs"), "utf8")).toBe("https://github.com/owner/repo/pull/8\n");
});

test("draft release checks the exact snapshot with the job token and keeps the App token for readiness", () => {
  const setup = fixture(), url = "https://github.com/owner/repo/pull/8";
  writeFileSync(join(setup.dir, "forked-prs"), `${url}\n`);
  executable(setup.dir, "sleep", "#!/bin/sh\nexit 0\n");
  executable(setup.dir, "gh", `#!/bin/sh
case "$1 $2" in
  "api repos/owner/repo/actions/artifacts/27") [ "$GH_TOKEN" = token ] && echo true ;;
  "pr ready") [ -z "$GH_TOKEN" ] && echo "$3" >> "$RUNNER_TEMP/ready" ;;
  *) exit 1 ;;
esac
`);
  expect(run("Mark forked PRs ready", setup, { SNAPSHOT_ID: "27", GH_TOKEN: "" }).exitCode).toBe(0);
  expect(readFileSync(join(setup.dir, "ready"), "utf8")).toBe(`${url}\n`);
});
