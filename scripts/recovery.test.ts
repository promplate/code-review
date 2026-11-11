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
  expect(step("Mark forked PRs ready").if).toBe("always()");
});

test("snapshot cleanup preserves other refs and waits for the saved snapshot", () => {
  for (const ref of ["refs/heads/main", "refs/pull/7/merge", "refs/heads/release+next", "refs/heads/release&next", "refs/heads/release#next"]) {
    for (const visible of [true, false]) {
      const setup = fixture(), prefix = "code-review-default-pr-7:", key = `${prefix}12-1`;
      const caches = [{ key: `${prefix}10-1`, ref }, { key: `${prefix}11-1`, ref: "refs/heads/other" }];
      if (visible) caches.push({ key, ref });
      writeFileSync(join(setup.dir, "caches.json"), JSON.stringify(caches));
      executable(setup.dir, "gh", `#!${process.execPath}
const args = process.argv.slice(2), url = new URL(args.find(arg => arg.startsWith("repos/")), "https://api.github.com/");
const path = process.env.RUNNER_TEMP + "/caches.json", caches = await Bun.file(path).json();
if (args.includes("DELETE")) {
  await Bun.write(path, JSON.stringify(caches.filter(cache => cache.key !== url.searchParams.get("key"))));
} else {
  const matches = caches.filter(cache => cache.key.startsWith(url.searchParams.get("key")) && (!url.searchParams.has("ref") || cache.ref === url.searchParams.get("ref")));
  const result = Bun.spawnSync(["jq", "-r", args[args.indexOf("--jq") + 1]], { stdin: Buffer.from(JSON.stringify({ actions_caches: matches })) });
  process.stdout.write(result.stdout);
  process.exit(result.exitCode);
}
`);
      expect(run("Drop older session snapshots", setup, { MODEL_NAME: "default", SESSION_KEY: "pr-7", KEY: key, GITHUB_REF: ref }).exitCode).toBe(0);
      expect(JSON.parse(readFileSync(join(setup.dir, "caches.json"), "utf8"))).toEqual(visible ? caches.slice(1) : caches);
    }
  }
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

test("a failed publication releases only drafts an earlier run left pending", () => {
  const setup = fixture();
  writeFileSync(join(setup.dir, "forked-prs"), "https://github.com/owner/repo/pull/8\n");
  writeFileSync(join(setup.dir, "sessions/.github-pending-drafts"), "https://github.com/owner/repo/pull/9\n");
  executable(setup.dir, "gh", '#!/bin/sh\n[ "$1 $2" = "pr ready" ] || exit 1\necho "$3" >> "$RUNNER_TEMP/ready"\n');
  const result = run("Mark forked PRs ready", setup, { SAVE_OUTCOME: "skipped" });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("stay draft");
  expect(readFileSync(join(setup.dir, "ready"), "utf8")).toBe("https://github.com/owner/repo/pull/9\n");
  // The draft this run opened has no saved source session, so it stays draft for a manual release.
  expect(existsSync(join(setup.dir, "sessions/.github-pending-drafts"))).toBe(false);
});

test.each([
  ["", { SAVE_OUTCOME: "skipped" }, false],
  ["forked-prs", { SAVE_OUTCOME: "success" }, true],
  ["sessions/.github-pending-drafts", { SAVE_OUTCOME: "skipped" }, true],
])("draft release accepts optional lists: %s", (file, extra, released) => {
  const setup = fixture(), url = "https://github.com/owner/repo/pull/8";
  if (file) writeFileSync(join(setup.dir, file), `${url}\n`);
  executable(setup.dir, "gh", `#!/bin/sh
case "$*" in
  *actions/caches*) echo true ;;
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
  *actions/caches*) echo true ;;
  "pr ready "*) echo "$3" >> "$RUNNER_TEMP/ready" ;;
  *) exit 1 ;;
esac
`);
  expect(run("Mark forked PRs ready", setup, { SAVE_OUTCOME: "success" }).exitCode).toBe(0);
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
  expect(run("Mark forked PRs ready", setup, { SKIP: "true", SAVE_OUTCOME: "skipped" }).exitCode).toBe(0);
  expect(readFileSync(join(setup.dir, "ready"), "utf8")).toBe("https://github.com/owner/repo/pull/8\n");
});

test("a draft stays draft when the saved session is not listed", () => {
  const setup = fixture();
  writeFileSync(join(setup.dir, "forked-prs"), "https://github.com/owner/repo/pull/8\n");
  executable(setup.dir, "gh", `#!/bin/sh
case "$*" in
  *actions/caches*) echo false ;;
  "pr ready "*) echo "$3" >> "$RUNNER_TEMP/ready" ;;
  *) exit 1 ;;
esac
`);
  expect(run("Mark forked PRs ready", setup, { SAVE_OUTCOME: "success" }).exitCode).toBe(0);
  expect(existsSync(join(setup.dir, "ready"))).toBe(false);
  expect(readFileSync(join(setup.dir, "forked-prs"), "utf8")).toBe("https://github.com/owner/repo/pull/8\n");
});

test("draft release checks the exact snapshot with the job token and keeps the App token for readiness", () => {
  for (const ref of ["refs/heads/main", "refs/heads/release+next", "refs/heads/release&next", "refs/heads/release#next"]) {
    for (const visible of [true, false]) {
      const setup = fixture(), key = `code-review-default-ref-${ref}:12-1`, url = "https://github.com/owner/repo/pull/8";
      writeFileSync(join(setup.dir, "forked-prs"), `${url}\n`);
      executable(setup.dir, "sleep", "#!/bin/sh\nexit 0\n");
      executable(setup.dir, "gh", `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === "api") {
  if (process.env.GH_TOKEN !== "token") process.exit(1);
  const url = new URL(args[1], "https://api.github.com/");
  for (let i = 0; i < args.length; i++) if (args[i] === "-f") {
    const field = args[++i], split = field.indexOf("=");
    url.searchParams.append(field.slice(0, split), field.slice(split + 1));
  }
  const matches = url.searchParams.get("ref") === process.env.GITHUB_REF && url.searchParams.get("key") === process.env.KEY;
  const actions_caches = matches && ${visible} ? [{ key: process.env.KEY }] : [{ key: process.env.KEY + "-other" }];
  const result = Bun.spawnSync(["jq", "-r", args[args.indexOf("--jq") + 1]], { stdin: Buffer.from(JSON.stringify({ actions_caches })) });
  process.stdout.write(result.stdout);
  process.exit(result.exitCode);
} else if (args[0] === "pr" && args[1] === "ready") {
  if (process.env.GH_TOKEN) process.exit(1);
  await Bun.write(process.env.RUNNER_TEMP + "/ready", args[2] + "\\n");
} else process.exit(1);
`);
      expect(run("Mark forked PRs ready", setup, { SAVE_OUTCOME: "success", GH_TOKEN: "", KEY: key, GITHUB_REF: ref }).exitCode).toBe(0);
      expect(existsSync(join(setup.dir, "ready"))).toBe(visible);
      if (visible) expect(readFileSync(join(setup.dir, "ready"), "utf8")).toBe(`${url}\n`);
    }
  }
});
