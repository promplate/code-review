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
    GITHUB_REPOSITORY: "owner/repo", GITHUB_ENV: join(dir, "github-env"), GITHUB_EVENT_PATH: join(dir, "event.json"), GITHUB_EVENT_NAME: "issue_comment",
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
    .replaceAll("${{ steps.check.outputs.id }}", "10").replaceAll("${{ github.token }}", "token").replace(/\$\{\{[^}]+\}\}/g, "");
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
    expect(run("Resolve the review target", setup, { GITHUB_EVENT_NAME: kind }).exitCode).toBe(0);
    expect(readFileSync(join(setup.dir, "github-env"), "utf8")).toContain("HEAD_SHA=new\n");
    expect(readFileSync(join(setup.dir, "github-env"), "utf8")).not.toContain("SKIP=true");
    expect(readFileSync(join(setup.dir, "event.json"), "utf8")).toBe(before);
  }
});

test("a synchronize retry requires a published checkpoint, including for older caches", () => {
  const setup = fixture({ action: "synchronize", pull_request: { number: 7, head: { sha: "old" } } });
  expect(gate(setup, { GITHUB_EVENT_NAME: "pull_request_target" })).not.toContain("SKIP=true");
  writeFileSync(join(setup.dir, "sessions/.github-published-head"), "old\n");
  expect(gate(setup, { GITHUB_EVENT_NAME: "pull_request_target" })).not.toContain("SKIP=true");
  writeFileSync(join(setup.dir, "sessions/.github-published-head"), "head\n");
  expect(gate(setup, { GITHUB_EVENT_NAME: "pull_request_target" })).toContain("SKIP=true");
});

test("every publication precedes checkpointing and cache save, while merge waits follow it", () => {
  const index = (name: string) => steps.indexOf(step(name));
  const checkpoint = index("Checkpoint published review"), save = index("Save codex session");
  for (const name of ["Publish check run", "Publish other commit verdicts", "Publish PR review", "Finish PR reactions", "Write review summary"]) expect(index(name)).toBeLessThan(checkpoint);
  expect(checkpoint).toBeLessThan(save);
  expect(save).toBeLessThan(index("Merge PR"));
  expect(step("Checkpoint published review").if).not.toMatch(/always\(|failure\(/);
  expect(step("Save codex session").if).not.toMatch(/always\(|failure\(/);
  expect(step("Save codex session")["continue-on-error"]).toBe(true);
  expect(step("Drop older session snapshots").if).toBe("steps.save-session.outcome == 'success'");
  // A failed publication skips the cache save, so drafts must still be released from the runner and the session copy.
  expect(step("Mark forked PRs ready").if).toBe("always() && env.SKIP != 'true'");
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
    writeFileSync(path("injected-deliveries.json"), JSON.stringify([delivery]));
    writeFileSync(path("injected-cursor"), "seq:epoch:2\n");
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
      expect(readFileSync(path("sessions/.github-cursor"), "utf8")).toBe("seq:epoch:2\n");
      expect(gate(setup, { HEAD_SHA: "new" })).not.toContain("SKIP=true");
    }
  });
}

test("cache upload failure restores the previous checkpoint and replays newer activity", () => {
  const setup = fixture();
  executable(setup.dir, "gh", "#!/bin/sh\nprintf 'write\\n'\n");
  writeFileSync(join(setup.dir, "sessions/.github-deliveries.json"), "[]");
  writeFileSync(join(setup.dir, "sessions/.github-published-head"), "old\n");
  cpSync(join(setup.dir, "sessions"), join(setup.dir, "saved"), { recursive: true });
  writeFileSync(join(setup.dir, "injected-deliveries.json"), JSON.stringify([delivery]));
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
  writeFileSync(join(setup.dir, "injected-deliveries.json"), "[]");
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

test("a failed publication still releases the drafted fix PRs", () => {
  const setup = fixture();
  writeFileSync(join(setup.dir, "forked-prs"), "https://github.com/owner/repo/pull/8\n");
  writeFileSync(join(setup.dir, "sessions/.github-pending-drafts"), "https://github.com/owner/repo/pull/9\n");
  executable(setup.dir, "sleep", "#!/bin/sh\nexit 0\n");
  executable(setup.dir, "gh", '#!/bin/sh\n[ "$1 $2" = "pr ready" ] || exit 1\n[ "$3" != "https://github.com/owner/repo/pull/9" ] || exit 1\necho "$3" >> "$RUNNER_TEMP/ready"\n');
  const result = run("Mark forked PRs ready", setup);
  expect(result.exitCode).toBe(0);
  expect(readFileSync(join(setup.dir, "ready"), "utf8")).toBe("https://github.com/owner/repo/pull/8\n");
  // The URL that could not be marked ready stays for the retry that restores this session.
  expect(readFileSync(join(setup.dir, "sessions/.github-pending-drafts"), "utf8")).toBe("https://github.com/owner/repo/pull/9\n");
});
