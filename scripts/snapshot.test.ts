import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const script = join(root, "scripts/snapshot.sh");
const warning = "::warning::Snapshots are not encrypted; anyone who can read this repository can download them.";

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
    env: { ...process.env, RUNNER_TEMP: runnerTemp, GITHUB_ACTION_PATH: root, GITHUB_ENV: "", CODE_REVIEW_PLAINTEXT_SNAPSHOT_WARNED: "", BROKER: `http://127.0.0.1:${server.port}`, ACTIONS_ID_TOKEN_REQUEST_URL: `http://127.0.0.1:${server.port}/oidc?repo=${repo}&`, ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runner", ENCRYPT_SNAPSHOTS: "true", ...extraEnv },
    stdout: "pipe", stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { exitCode, stdout, stderr };
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
  expect(saved.stdout).toContain(warning);
  expect(readFileSync(archive).subarray(0, 7).toString()).toBe("CRSNP0\n");
  const target = home({});
  expect((await run(["load", archive, target], "23", { BROKER: "" })).exitCode).toBe(0);
  expect(readFileSync(join(target, "last-thread-id"), "utf8")).toBe("thread-1\n");
});

test.each(["session", "events"])("plaintext archives warn once per job when %s is saved first", async first => {
  const source = home({ "last-thread-id": "thread-1\n", "codex.jsonl": "review event\n", "first-env": "OTHER=value\n", "next-env": "" });
  const session = ["save", join(source, "snapshot.bin"), source];
  const events = ["save", join(source, "codex.jsonl.bin"), source, "codex.jsonl"];
  const [firstSave, nextSave] = first === "session" ? [session, events] : [events, session];
  const env = { ENCRYPT_SNAPSHOTS: "false", BROKER: "", GITHUB_ENV: join(source, "first-env") };
  const saved = await run(firstSave, "23", env);
  expect(saved.exitCode).toBe(0);
  expect(saved.stdout.split("\n").filter(line => line === warning)).toHaveLength(1);
  // Each Actions step has a new env file; the runner carries its additions into the next process.
  const persisted = Object.fromEntries(readFileSync(env.GITHUB_ENV, "utf8").trim().split("\n").map(line => line.split("=")));
  expect(persisted.OTHER).toBe("value");
  const next = await run(nextSave, "23", { ...env, ...persisted, GITHUB_ENV: join(source, "next-env") });
  expect(next.exitCode).toBe(0);
  expect(next.stdout).not.toContain(warning);
  expect(readFileSync(join(source, "next-env"), "utf8")).toBe("");
  for (const archive of [session[1], events[1]]) expect(readFileSync(archive).subarray(0, 7).toString()).toBe("CRSNP0\n");
  // A fresh job on the same runner must warn again, even when its source files are reused.
  const fresh = await run(nextSave, "23", { ...env, GITHUB_ENV: join(source, "next-env") });
  expect(fresh.exitCode).toBe(0);
  expect(fresh.stdout).toContain(warning);
});

test("failed and encrypted saves leave the first plaintext warning available", async () => {
  const source = home({ "last-thread-id": "thread-1\n", "codex.jsonl": "review event\n", "github-env": "" });
  const env = { GITHUB_ENV: join(source, "github-env") };
  const archive = join(source, "snapshot.bin");
  const failed = await run(["save", archive, home({})], "23", { ...env, ENCRYPT_SNAPSHOTS: "false" });
  expect(failed.exitCode).not.toBe(0);
  expect(failed.stdout).not.toContain(warning);
  expect(readFileSync(env.GITHUB_ENV, "utf8")).toBe("");
  const encrypted = await run(["save", archive, source], "23", env);
  expect(encrypted.exitCode).toBe(0);
  expect(encrypted.stdout).not.toContain(warning);
  expect(readFileSync(archive).subarray(0, 7).toString()).toBe("CRSNP1\n");
  expect(readFileSync(env.GITHUB_ENV, "utf8")).toBe("");
  const plain = await run(["save", join(source, "codex.jsonl.bin"), source, "codex.jsonl"], "23", { ...env, ENCRYPT_SNAPSHOTS: "false" });
  expect(plain.exitCode).toBe(0);
  expect(plain.stdout).toContain(warning);
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
