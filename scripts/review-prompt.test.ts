import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const helper = join(import.meta.dir, "review-prompt.sh");
const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "review-prompt-"));
  homes.push(home);
  const action = join(home, "action"), sessions = join(home, "sessions", "2026", "11", "22");
  mkdirSync(join(action, "scripts"), { recursive: true });
  mkdirSync(sessions, { recursive: true });
  const instructions = join(action, "scripts", "instructions.sh");
  writeFileSync(instructions, "review rules\n");
  writeFileSync(join(action, "scripts", "run-review.sh"), "resume logic\n");
  const rollout = join(sessions, "rollout-2026-11-22T00-00-00-thread-1.jsonl");
  writeFileSync(rollout, '{"type":"turn_context"}\n');
  const env = { ...process.env, GITHUB_ACTION_PATH: action, CODEX_HOME: home, AGENT: "false", MODE_INSTRUCTIONS: "PR review", EXTRA_INSTRUCTIONS: "" };
  const run = (command: string, values: Record<string, string> = {}) => {
    const result = Bun.spawnSync(["bash", "-ec", "source \"$PROMPT_HELPER\"; " + command], { env: { ...env, ...values, PROMPT_HELPER: helper } });
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    return result.stdout.toString().trim();
  };
  const version = () => run("review_prompt_version");
  const compactions = (thread = "thread-1") => run('review_prompt_compactions "$THREAD"', { THREAD: thread });
  const needs = (thread: string, policy: string, count: string) =>
    run('if review_prompt_needs_rules "$THREAD" "$VERSION" "$COUNT"; then echo full; else echo short; fi',
      { THREAD: thread, VERSION: policy, COUNT: count });
  const record = (thread: string, policy: string, count: string) =>
    run('review_prompt_record "$THREAD" "$VERSION" "$COUNT"', { THREAD: thread, VERSION: policy, COUNT: count });
  return { env, rollout, instructions, version, compactions, needs, record };
}

test("resume omits unchanged rules but refreshes updated instructions and compacted history", () => {
  const f = fixture(), version = f.version();
  expect(f.compactions()).toBe("0");
  expect(f.needs("thread-1", version, "0")).toBe("full"); // legacy or first run
  f.record("thread-1", version, "0");
  expect(f.needs("thread-1", version, "0")).toBe("short");
  appendFileSync(f.rollout, '{"type":"compacted","payload":{}}\n');
  expect(f.compactions()).toBe("1");
  expect(f.needs("thread-1", version, "1")).toBe("full");
  f.record("thread-1", version, "1");
  expect(f.needs("thread-1", version, "1")).toBe("short");
  writeFileSync(f.instructions, "updated review rules\n");
  const updated = f.version();
  expect(updated).not.toBe(version);
  expect(f.needs("thread-1", updated, "1")).toBe("full");
  f.record("thread-1", updated, "1");
  f.env.EXTRA_INSTRUCTIONS = "new repository policy";
  expect(f.needs("thread-1", f.version(), "1")).toBe("full");
  expect(f.needs("thread-2", updated, "1")).toBe("full");
  expect(f.compactions("thread-2")).toBe("unknown");
});

test("missing rollout never suppresses a policy refresh", () => {
  const f = fixture(), version = f.version();
  f.record("thread-1", version, "0");
  rmSync(f.rollout);
  expect(f.compactions()).toBe("unknown");
  expect(f.needs("thread-1", version, "unknown")).toBe("full");
});

test("review and issue resumes use current context without unconditional rule replay", () => {
  const script = readFileSync(join(import.meta.dir, "run-review.sh"), "utf8");
  expect(script).toContain('if review_prompt_needs_rules "$thread" "$prompt_version" "$resume_compactions"');
  expect(script).toContain("This run context supersedes earlier HEAD");
  expect(script).toContain("This run context supersedes older head");
  expect(script).not.toContain("covering what this run saw. $CONFLICT$INSTRUCTIONS");
  expect(script).not.toContain("finish the response, and reply there. %s");
});
