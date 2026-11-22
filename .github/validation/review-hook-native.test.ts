import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(process.env.REVIEW_VALIDATION_ROOT || process.cwd());
const bash = process.env.REVIEW_VALIDATION_BASH || Bun.which("bash")!;
const fixtures: ReturnType<typeof fixture>[] = [];

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "review-hook-native-"));
  const body = { sender: { login: "writer", type: "User" }, action: "created", issue: { number: 7 }, comment: { body: "native-runner-event" } };
  const stream = `id: native-event\ndata: ${JSON.stringify({ event: "issue_comment", delivery: "native-event", writer: true, body: JSON.stringify(body) })}\n\n`;
  writeFileSync(join(dir, "sse.jsonl"), stream);
  writeFileSync(join(dir, "injected.log"), "");
  const setup = {
    dir,
    env: { ...process.env, RUNNER_TEMP: dir, GITHUB_ACTION_PATH: root, GITHUB_REPOSITORY: "owner/repo", PR_NUMBER: "7", HEAD_SHA: "head", HEAD_BRANCH: "feature", BOT_LOGIN: "reviewer[bot]", CHECK_ID: "" },
    holders: [] as ReturnType<typeof Bun.spawn>[],
    hooks: [] as { child: ReturnType<typeof Bun.spawn>; result: Promise<{ code: number; output: string; error: string }> }[],
  };
  fixtures.push(setup);
  return setup;
}

function hook(setup: ReturnType<typeof fixture>, event = "Stop") {
  const child = Bun.spawn([bash, join(root, "scripts", "review-hook.sh")], {
    cwd: root, env: setup.env, stdin: Buffer.from(JSON.stringify({ hook_event_name: event })), stdout: "pipe", stderr: "pipe",
  });
  const result = Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    .then(([code, output, error]) => ({ code, output, error }));
  const entry = { child, result };
  setup.hooks.push(entry);
  return entry;
}

async function holder(setup: ReturnType<typeof fixture>) {
  const path = join(setup.dir, "holder.mjs");
  writeFileSync(path, `import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const db = new Database(join(process.env.RUNNER_TEMP, "injected-deliveries.sqlite"));
db.exec("BEGIN IMMEDIATE");
writeFileSync(join(process.env.RUNNER_TEMP, "holder-ready"), "");
await Bun.sleep(60000);
db.close();\n`);
  const child = Bun.spawn([process.execPath, `--config=${join(root, "scripts", "review-bun.toml")}`, path], {
    cwd: root, env: setup.env, stdin: "ignore", stdout: "ignore", stderr: "inherit",
  });
  setup.holders.push(child);
  const deadline = Date.now() + 5000;
  while (!existsSync(join(setup.dir, "holder-ready"))) {
    if (child.exitCode != null || Date.now() > deadline) throw new Error("Native lock holder did not start");
    await Bun.sleep(10);
  }
  return child;
}

function expectDeliveredOnce(setup: ReturnType<typeof fixture>, results: Awaited<ReturnType<typeof hook>["result"]>[]) {
  for (const result of results) {
    expect(result.code).toBe(0);
    expect(result.error).toBe("");
  }
  expect(results.filter(result => result.output.includes("native-runner-event"))).toHaveLength(1);
  expect(readFileSync(join(setup.dir, "injected-deliveries.log"), "utf8")).toBe("native-event\n");
  expect(readFileSync(join(setup.dir, "injected.log"), "utf8").trim().split("\n")).toHaveLength(1);
  expect(existsSync(join(setup.dir, "injected-deliveries.sqlite"))).toBe(true);
}

afterEach(async () => {
  for (const setup of fixtures.splice(0)) {
    for (const child of setup.holders) if (child.exitCode == null) child.kill("SIGKILL");
    await Promise.all(setup.holders.map(child => child.exited));
    // Releasing native holders lets even a failed assertion's queued hooks finish.
    await Promise.all(setup.hooks.map(entry => entry.result));
    rmSync(setup.dir, { recursive: true, force: true });
  }
});

test.each([false, true])("native Bash hook serializes concurrent delivery (legacy directory: %s)", async legacy => {
  const setup = fixture();
  if (legacy) mkdirSync(join(setup.dir, "injected-deliveries.lock"));
  const results = await Promise.all(Array.from({ length: 8 }, () => hook(setup, "PostToolUse").result));
  expectDeliveredOnce(setup, results);
  const next = await hook(setup).result;
  expect(next).toEqual({ code: 0, output: "", error: "" });
  if (legacy) expect(existsSync(join(setup.dir, "injected-deliveries.lock"))).toBe(true);
}, 20000);

test.each(["SIGTERM", "SIGKILL"] as const)("native SQLite ownership recovers after %s with competing hooks", async signal => {
  const setup = fixture();
  const owner = await holder(setup);
  const pending = Array.from({ length: 6 }, () => hook(setup).result);
  await Bun.sleep(200);
  expect(existsSync(join(setup.dir, "injected-deliveries.log"))).toBe(false);
  owner.kill(signal);
  await owner.exited;
  expectDeliveredOnce(setup, await Promise.all(pending));
  expect((await hook(setup).result).output).toBe("");
}, 20000);

test("native hook times out without evicting a live owner or acknowledging activity", async () => {
  const setup = fixture();
  const owner = await holder(setup);
  const started = Date.now();
  const result = await hook(setup).result;
  expect(Date.now() - started).toBeGreaterThanOrEqual(4900);
  expect(Date.now() - started).toBeLessThan(15000);
  expect(result.code).not.toBe(0);
  expect(result.output).toBe("");
  expect(result.error).toContain("Timed out waiting for the review hook delivery lock");
  expect(owner.exitCode == null).toBe(true);
  expect(existsSync(join(setup.dir, "injected-deliveries.log"))).toBe(false);
  expect(existsSync(join(setup.dir, "injected.size"))).toBe(false);
  expect(readFileSync(join(setup.dir, "injected.log"), "utf8")).toBe("");
  owner.kill("SIGKILL");
  await owner.exited;
  expectDeliveredOnce(setup, [await hook(setup).result]);
}, 20000);
