import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const script = join(root, "scripts/snapshot.sh");

// Stands in for the broker: the OIDC value names the repository, and the key is derived from that alone.
let recoveringRequests = 0;
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/oidc") return Response.json({ value: `repo:${url.searchParams.get("repo")}` });
    const repo = request.headers.get("authorization")?.replace(/^Bearer repo:/, "") ?? "";
    // A broker that predates snapshot keys answers 404, like any route it does not serve.
    if (repo === "legacy") return new Response("not found", { status: 404 });
    if (repo === "broken") return new Response("boom", { status: 400 });
    if (repo === "recovering" && ++recoveringRequests === 1) return new Response("temporarily unavailable", { status: 503 });
    if (url.pathname !== "/snapshot-key" || !repo) return new Response("bad token", { status: 401 });
    const key = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`snapshot:${repo}`)));
    return Response.json({ key: Buffer.from(key).toString("base64") });
  },
});
afterAll(() => server.stop(true));

const homes: string[] = [];
function home(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "review-snapshot-"));
  homes.push(dir);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}
afterAll(() => homes.forEach(dir => rmSync(dir, { recursive: true, force: true })));
const runnerTemp = home({});

// The broker answers on this process, so the script must run without blocking the event loop.
async function run(args: string[], repo = "23", extraEnv: Record<string, string> = {}) {
  const proc = Bun.spawn(["bash", script, ...args], {
    env: { ...process.env, GITHUB_ENV: "", UNENCRYPTED_SNAPSHOT_WARNED: "", RUNNER_TEMP: runnerTemp, GITHUB_ACTION_PATH: root, BROKER: `http://127.0.0.1:${server.port}`, ACTIONS_ID_TOKEN_REQUEST_URL: `http://127.0.0.1:${server.port}/oidc?repo=${repo}&`, ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runner", ENCRYPT_SNAPSHOTS: "true", ...extraEnv },
    stdout: "pipe", stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { exitCode, stdout, stderr };
}

// GitHub exports $GITHUB_ENV writes into the later steps of the same job.
function jobEnv(file: string) {
  const env: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const mark = line.indexOf("=");
    if (mark > 0) env[line.slice(0, mark)] = line.slice(mark + 1);
  }
  return env;
}

test("save encrypts the session and load restores it", async () => {
  const source = home({ "sessions/a.jsonl": '{"secret":"sk-live-123"}\n', "last-thread-id": "thread-1\n", "check-runs.jsonl": "" });
  const archive = join(home({}), "snapshot.bin");
  expect((await run(["save", archive, source, "sessions", "last-thread-id", "check-runs.jsonl"])).exitCode).toBe(0);
  const bytes = readFileSync(archive);
  expect(bytes.subarray(0, 7).toString()).toBe("CRSNP1\n");
  // The upload must not carry the conversation in the clear.
  expect(bytes.includes("sk-live-123")).toBe(false);
  const target = home({});
  expect((await run(["load", archive, target])).exitCode).toBe(0);
  expect(readFileSync(join(target, "sessions/a.jsonl"), "utf8")).toContain("sk-live-123");
  expect(readFileSync(join(target, "last-thread-id"), "utf8")).toBe("thread-1\n");
  expect(existsSync(archive)).toBe(false);
});

test.each(["false", "true"])("save prunes only obsolete reasoning in the archive (encryption=%s)", async encryption => {
  const id = "11111111-1111-4111-8111-111111111111";
  const path = `sessions/2026/01/01/rollout-2026-01-01T00-00-00-${id}.jsonl`;
  const row = (type: string, payload: unknown) => JSON.stringify({ timestamp: "2026-01-01T00:00:00Z", type, payload }) + "\n";
  const reasoning = (id: string) => ({ type: "reasoning", id, summary: [{ type: "summary_text", text: "历史摘要" }], content: [{ type: "reasoning_text", text: "old thinking" }], encrypted_content: "opaque-reasoning-body" });
  const prefix = [
    row("session_meta", { id, history_mode: "paginated" }),
    row("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "Keep the user's instructions." }] }),
    row("response_item", reasoning("old")),
    row("event_msg", { type: "item_completed", item: { type: "Reasoning", id: "old", summary_text: ["历史摘要"], raw_content: ["old thinking"] } }),
  ];
  const current = [
    row("compacted", { message: "checkpoint", replacement_history: [], window_number: 1, guardian_history: [reasoning("guardian")] }),
    row("response_item", reasoning("current")),
  ];
  const original = prefix.concat(current).join("");
  const source = home({ [path]: original, "last-thread-id": id }), target = home({}), temporary = home({});
  utimesSync(join(source, "sessions/2026"), 1_700_000_000, 1_700_000_000);
  const archive = join(home({}), "snapshot.bin");
  const env = { ENCRYPT_SNAPSHOTS: encryption, TMPDIR: temporary };
  expect((await run(["save", archive, source], "23", env)).exitCode).toBe(0);
  expect(readFileSync(join(source, path), "utf8")).toBe(original);
  expect(readdirSync(temporary)).toEqual([]);
  expect((await run(["load", archive, target], "23", env)).exitCode).toBe(0);
  expect(statSync(join(target, "sessions/2026")).mtimeMs).toBe(1_700_000_000_000);
  const restored = readFileSync(join(target, path), "utf8").split(/(?<=\n)/);
  expect(restored.map(line => Buffer.byteLength(line))).toEqual(prefix.concat(current).map(line => Buffer.byteLength(line)));
  expect(restored.slice(0, 2)).toEqual(prefix.slice(0, 2));
  expect(restored.slice(prefix.length)).toEqual(current);
  expect(JSON.parse(restored[2]).payload).toEqual({ ...reasoning("old"), summary: [], content: null, encrypted_content: null });
  expect(JSON.parse(restored[3]).payload.item).toEqual({ type: "Reasoning", id: "old", summary_text: [], raw_content: [] });
  // Even a key failure after cleanup must leave the live session intact.
  if (encryption === "true") {
    expect((await run(["save", archive, source], "broken", env)).exitCode).not.toBe(0);
    expect(existsSync(archive)).toBe(false);
    expect(readFileSync(join(source, path), "utf8")).toBe(original);
    expect(readdirSync(temporary)).toEqual([]);
  }
});

test.each(["read-only directory", "hard link"])("saves a session containing a %s intact", async kind => {
  const id = "11111111-1111-4111-8111-111111111111";
  const path = `sessions/rollout-2026-01-01T00-00-00-${id}.jsonl`;
  const rollout = [
    { type: "session_meta", payload: { id, history_mode: "paginated" } },
    { type: "response_item", payload: { type: "reasoning", summary: [], encrypted_content: "historical reasoning" } },
    { type: "compacted", payload: { message: "", window_number: 1, replacement_history: [] } },
  ].map((row, ordinal) => JSON.stringify({ timestamp: "2026-01-01T00:00:00Z", ordinal, ...row }) + "\n").join("");
  const source = home({ [path]: rollout, "sessions/nested/receipt": "saved" }), target = home({}), temporary = home({});
  const archive = join(home({}), "snapshot.bin");
  const nested = "sessions/nested", receipt = nested + "/receipt", alias = nested + "/copy";
  if (kind === "hard link") linkSync(join(source, receipt), join(source, alias));
  else chmodSync(join(source, nested), 0o555);
  try {
    expect((await run(["save", archive, source], "23", { TMPDIR: temporary })).exitCode).toBe(0);
    expect(readdirSync(temporary)).toEqual([]);
    expect((await run(["load", archive, target])).exitCode).toBe(0);
    expect(readFileSync(join(target, path), "utf8")).toBe(rollout);
    expect(readFileSync(join(target, receipt), "utf8")).toBe("saved");
    if (kind === "hard link") expect(statSync(join(target, alias)).ino).toBe(statSync(join(target, receipt)).ino);
    else expect(statSync(join(target, nested)).mode & 0o777).toBe(0o555);
  } finally {
    // The test runner owns these fixtures and must be able to remove their contents.
    chmodSync(join(source, nested), 0o700);
    if (existsSync(join(target, nested))) chmodSync(join(target, nested), 0o700);
    for (const entry of readdirSync(temporary)) {
      const staged = join(temporary, entry, nested);
      if (existsSync(staged)) chmodSync(staged, 0o700);
    }
  }
});

test("a modified archive or another repository's key restores nothing", async () => {
  const source = home({ "last-thread-id": "thread-1\n" });
  const archive = join(home({}), "snapshot.bin");
  expect((await run(["save", archive, source, "last-thread-id"])).exitCode).toBe(0);
  const bytes = readFileSync(archive);
  bytes[bytes.length - 1] ^= 1;
  writeFileSync(archive, bytes);
  const target = home({});
  const tampered = await run(["load", archive, target]);
  expect(tampered.exitCode).not.toBe(0);
  expect(tampered.stderr).toContain("could not be decrypted");
  expect(existsSync(join(target, "last-thread-id"))).toBe(false);

  const clean = join(home({}), "snapshot.bin");
  expect((await run(["save", clean, source, "last-thread-id"])).exitCode).toBe(0);
  expect((await run(["load", clean, home({})], "24")).exitCode).not.toBe(0);
});

test("an artifact saved before snapshots became one archive still restores its unpacked files", async () => {
  const target = home({ "sessions/a.jsonl": "{}\n" });
  expect((await run(["load", join(target, "snapshot.bin"), target])).exitCode).toBe(0);
  expect(existsSync(join(target, "sessions/a.jsonl"))).toBe(true);
});

test("a broker without the endpoint saves nothing, in the clear or otherwise", async () => {
  const source = home({ "last-thread-id": "thread-1\n" });
  const archive = join(home({}), "snapshot.bin");
  const saved = await run(["save", archive, source, "last-thread-id"], "legacy");
  expect(saved.exitCode).not.toBe(0);
  expect(saved.stderr).toContain("does not provide snapshot keys");
  expect(existsSync(archive)).toBe(false);
});

test("a restore that unpacked nothing fails instead of starting a fresh session", async () => {
  expect((await run(["load", join(home({}), "snapshot.bin"), home({})])).exitCode).not.toBe(0);
});

test("encryption is off unless the repository asks for it, and needs no broker", async () => {
  const source = home({ "last-thread-id": "thread-1\n" });
  const archive = join(home({}), "snapshot.bin");
  const saved = await run(["save", archive, source, "last-thread-id"], "23", { ENCRYPT_SNAPSHOTS: "false", BROKER: "" });
  expect(saved.exitCode).toBe(0);
  expect(readFileSync(archive).subarray(0, 7).toString()).toBe("CRSNP0\n");
  const target = home({});
  expect((await run(["load", archive, target], "23", { BROKER: "" })).exitCode).toBe(0);
  expect(readFileSync(join(target, "last-thread-id"), "utf8")).toBe("thread-1\n");
});

test("turning encryption off still restores what an encrypted save wrote", async () => {
  const source = home({ "last-thread-id": "thread-1\n" });
  const archive = join(home({}), "snapshot.bin");
  expect((await run(["save", archive, source, "last-thread-id"])).exitCode).toBe(0);
  expect(readFileSync(archive).subarray(0, 7).toString()).toBe("CRSNP1\n");
  const target = home({});
  // The archive says which format it is, so the read path never consults the input.
  expect((await run(["load", archive, target], "23", { ENCRYPT_SNAPSHOTS: "false" })).exitCode).toBe(0);
  expect(readFileSync(join(target, "last-thread-id"), "utf8")).toBe("thread-1\n");
});

test("a broker that fails the key request stores nothing", async () => {
  const source = home({ "last-thread-id": "thread-1\n" });
  const archive = join(home({}), "snapshot.bin");
  const saved = await run(["save", archive, source, "last-thread-id"], "broken");
  expect(saved.exitCode).not.toBe(0);
  expect(saved.stderr).toContain("Snapshot key request failed");
  expect(existsSync(archive)).toBe(false);
});

test("a capitalized true encrypts debug events and an invalid input saves nothing", async () => {
  const source = home({ "codex.jsonl": "review event\n" });
  const archive = join(home({}), "codex.jsonl.bin"), target = home({});
  const save = ["save", archive, source, "codex.jsonl"];
  expect((await run(save, "23", { ENCRYPT_SNAPSHOTS: "treu" })).exitCode).not.toBe(0);
  expect(existsSync(archive)).toBe(false);
  expect((await run(save, "23", { ENCRYPT_SNAPSHOTS: "True" })).exitCode).toBe(0);
  expect(readFileSync(archive).subarray(0, 7).toString()).toBe("CRSNP1\n");
  expect((await run(["load", archive, target], "23", { ENCRYPT_SNAPSHOTS: "false" })).exitCode).toBe(0);
  expect(readFileSync(join(target, "codex.jsonl"), "utf8")).toBe("review event\n");
});

test("a successful key retry saves a restorable snapshot", async () => {
  const source = home({ "last-thread-id": "thread" }), target = home({});
  const archive = join(home({}), "snapshot.bin");
  recoveringRequests = 0;
  expect((await run(["save", archive, source], "recovering")).exitCode).toBe(0);
  expect(recoveringRequests).toBe(2);
  expect((await run(["load", archive, target], "recovering")).exitCode).toBe(0);
  expect(readFileSync(join(target, "last-thread-id"), "utf8")).toBe("thread");
});

test("saving nothing fails instead of uploading an empty archive", async () => {
  const archive = join(home({}), "snapshot.bin");
  expect((await run(["save", archive, home({}), "sessions", "last-thread-id"])).exitCode).not.toBe(0);
  expect(existsSync(archive)).toBe(false);
});

test.each(["session", "events"])("an unencrypted job warns once when %s is saved first", async first => {
  const job = home({ "first-env": "", "next-env": "", "fresh-env": "" }), envFile = join(job, "first-env");
  const source = home({ "sessions/a.jsonl": "{}\n" }), events = home({ "codex.jsonl": "review event\n" });
  const archives = [
    ["save", join(job, "snapshot.bin"), source, "sessions"],
    ["save", join(job, "codex.jsonl.bin"), events, "codex.jsonl"],
  ];
  if (first === "events") archives.reverse();
  const base = { ENCRYPT_SNAPSHOTS: "false", BROKER: "" };
  const saved = await run(archives[0], "23", { ...base, GITHUB_ENV: envFile });
  expect(saved.exitCode).toBe(0);
  expect(saved.stdout.match(/^::warning::/gm) ?? []).toHaveLength(1);
  // Each step gets a new env file; only the exported variables carry over.
  const next = await run(archives[1], "23", { ...base, ...jobEnv(envFile), GITHUB_ENV: join(job, "next-env") });
  expect(next.exitCode).toBe(0);
  expect(next.stdout).not.toMatch(/^::warning::/m);
  expect(readFileSync(join(job, "codex.jsonl.bin")).subarray(0, 7).toString()).toBe("CRSNP0\n");
  // A fresh job on the same runner must warn again despite reusing the same source and archive paths.
  const fresh = await run(archives[1], "23", { ...base, GITHUB_ENV: join(job, "fresh-env") });
  expect(fresh.exitCode).toBe(0);
  expect(fresh.stdout.match(/^::warning::/gm) ?? []).toHaveLength(1);
});

test("the unencrypted warning still appears when only one archive is written", async () => {
  const job = home({}), envFile = join(job, "github-env");
  writeFileSync(envFile, "");
  const events = home({ "codex.jsonl": "review event\n" });
  const base = { GITHUB_ENV: envFile, ENCRYPT_SNAPSHOTS: "false", BROKER: "" };
  // A save that wrote nothing marks nothing, so the only artifact actually written keeps the warning.
  expect((await run(["save", join(job, "snapshot.bin"), home({}), "sessions"], "23", base)).exitCode).not.toBe(0);
  const debug = await run(["save", join(job, "codex.jsonl.bin"), events, "codex.jsonl"], "23", { ...base, ...jobEnv(envFile) });
  expect(debug.exitCode).toBe(0);
  expect(debug.stdout).toContain("::warning::Snapshots are not encrypted");
});

test("an encrypted save never warns about unencrypted snapshots", async () => {
  const job = home({}), envFile = join(job, "github-env");
  writeFileSync(envFile, "");
  const source = home({ "last-thread-id": "thread-1\n" });
  for (const archive of ["snapshot.bin", "again.bin"]) {
    const saved = await run(["save", join(job, archive), source, "last-thread-id"], "23", { GITHUB_ENV: envFile });
    expect(saved.exitCode).toBe(0);
    expect(saved.stdout).not.toContain("::warning::");
  }
});
