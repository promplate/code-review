import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const scripts = process.env.REVIEW_SCRIPTS_PATH || import.meta.dir;
const homes: string[] = [];
afterEach(() => { for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(errors: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "review-retry-"));
  homes.push(dir);
  writeFileSync(join(dir, "gh"), `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync } from "node:fs";
const dir = process.env.RUNNER_TEMP;
const file = dir + "/calls";
const count = existsSync(file) ? readFileSync(file, "utf8").trim().split("\\n").length : 0;
appendFileSync(file, JSON.stringify({ args: process.argv.slice(2), input: await Bun.stdin.text() }) + "\\n");
const errors = JSON.parse(process.env.ERRORS);
if (count < errors.length) { console.error(errors[count]); process.exit(1); }
console.log("ok");
console.error("success diagnostic");
`, { mode: 0o755 });
  writeFileSync(join(dir, "sleep"), '#!/bin/sh\nprintf "%s\\n" "$1" >> "$RUNNER_TEMP/delays"\n', { mode: 0o755 });
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, RUNNER_TEMP: dir, ERRORS: JSON.stringify(errors), GITHUB_ACTION_PATH: resolve(scripts, ".."), GITHUB_REPOSITORY: "owner/repo" };
  return { dir, env,
    calls: () => existsSync(join(dir, "calls")) ? readFileSync(join(dir, "calls"), "utf8").trim().split("\n").map(line => JSON.parse(line)) : [],
    delays: () => existsSync(join(dir, "delays")) ? readFileSync(join(dir, "delays"), "utf8").trim().split("\n").map(Number) : [],
    run: (args = ["api", "graphql"], input = "") => Bun.spawnSync(["bash", join(scripts, "retry.sh"), "gh", ...args], { env, stdin: Buffer.from(input), timeout: 3000 }),
  };
}

test.each([
  ...[400, 401, 403, 404, 422].map(status => `gh: request failed (HTTP ${status})`),
  'gh: Variable $pr of type Int! was provided invalid value',
  'gh: Resource not accessible by integration (HTTP 403)',
  'gh: GraphQL: Could not resolve to a PullRequest',
  'unknown flag: --bad',
  'unknown flag: --timeout',
  '',
  'gh: timeout is not allowed (HTTP 422)',
])("permanent failure stops without sleeping: %s", error => {
  const setup = fixture([error]);
  const result = setup.run();
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toBe(error + "\n");
  expect(setup.calls()).toHaveLength(1);
  expect(setup.delays()).toEqual([]);
});

test.each([
  'gh: Too Many Requests (HTTP 429)',
  ...[500, 502, 503, 504].map(status => `gh: request failed (HTTP ${status})`),
  'curl: (22) The requested URL returned error: 503',
  'fatal: unable to access remote: The requested URL returned error: 502',
  'Post "https://api.github.com/graphql": dial tcp: lookup api.github.com: no such host',
  'Get "https://api.github.com": net/http: TLS handshake timeout',
  'Get "https://api.github.com": i/o timeout',
  'curl: (28) Operation timed out after 1000 milliseconds',
  'read tcp: connection reset by peer',
  'dial tcp: connect: connection refused',
  'error connecting to api.github.com',
  'Post "https://api.github.com/graphql": unexpected EOF',
  'fatal: unable to access remote: Could not resolve host: github.com',
])("transient failure retries and replays stdin: %s", error => {
  const setup = fixture([error]);
  const args = ["api", "graphql", "--input", "-"];
  const input = '{"query":"mutation { example }"}';
  const result = setup.run(args, input);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe("ok\n");
  expect(result.stderr.toString()).toBe(error + "\nsuccess diagnostic\n");
  expect(setup.calls()).toEqual([{ args, input }, { args, input }]);
  expect(setup.delays()).toEqual([1]);
});

test("transient failures stop after eight attempts with capped backoff", () => {
  const setup = fixture(Array(8).fill("gh: HTTP 503"));
  expect(setup.run().exitCode).toBe(1);
  expect(setup.calls()).toHaveLength(8);
  expect(setup.delays()).toEqual([1, 2, 4, 8, 16, 30, 30]);
});

test("a permanent response after a network failure stops further retries", () => {
  const setup = fixture(['Post "https://api.github.com": EOF', 'gh: HTTP 403']);
  expect(setup.run().exitCode).toBe(1);
  expect(setup.calls()).toHaveLength(2);
  expect(setup.delays()).toEqual([1]);
});

test("DELETE 404 remains an idempotent success", () => {
  const setup = fixture(['gh: Not Found (HTTP 404)']);
  expect(setup.run(["api", "repos/owner/repo/reactions/1", "-X", "DELETE"]).exitCode).toBe(0);
  expect(setup.calls()).toHaveLength(1);
  expect(setup.delays()).toEqual([]);
});

test.each([undefined, ""])("resolve-thread rejects missing PR_NUMBER (%j) before calling gh", pr => {
  const setup = fixture([]);
  const result = Bun.spawnSync(["bash", join(scripts, "resolve-thread.sh"), "123", "Fixed"], { env: { ...setup.env, PR_NUMBER: pr }, timeout: 3000 });
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("resolve-thread.sh requires PR_NUMBER");
  expect(setup.calls()).toEqual([]);
});

test("resolve-thread still queries, replies and resolves with a PR number", () => {
  const setup = fixture([]);
  const result = Bun.spawnSync(["bash", join(scripts, "resolve-thread.sh"), "123", "Fixed"], { env: { ...setup.env, PR_NUMBER: "7" }, timeout: 3000 });
  expect(result.exitCode).toBe(0);
  const calls = setup.calls();
  expect(calls).toHaveLength(3);
  expect(calls[0].args).toContain("pr=7");
  expect(calls[1].args.join(" ")).toContain("addPullRequestReviewThreadReply");
  expect(calls[2].args.join(" ")).toContain("resolveReviewThread");
});
