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
if (count < errors.length) {
  console.log(JSON.stringify({ message: errors[count] }));
  console.error(errors[count]);
  process.exit(1);
}
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
  'gh: API rate limit exceeded for installation ID 123. (HTTP 403)',
  'gh: API rate limit exceeded for installation ID 123. (HTTP 429)',
])("permanent failure stops without sleeping: %s", error => {
  const setup = fixture([error]);
  const result = setup.run();
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toStartWith(error + "\n");
  // A decode error names no endpoint, so the failure always says which command produced it.
  expect(result.stderr.toString()).toContain("retry.sh: failed after 1 attempt(s): gh api graphql\n");
  expect(setup.calls()).toHaveLength(1);
  expect(setup.delays()).toEqual([]);
});

test("a read that loses its reply retries, a write does not", () => {
  const read = fixture(['Post "https://api.github.com/graphql": unexpected EOF']);
  expect(read.run(["api", "repos/owner/repo/pulls/7/reviews"]).exitCode).toBe(0);
  expect(read.calls()).toHaveLength(2);
  expect(read.delays()).toEqual([1]);
  const write = fixture(['fatal: the remote end hung up unexpectedly']);
  const result = write.run(["api", "graphql", "--input", "-"], '{"query":"mutation { example }"}');
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("retry.sh: failed after 1 attempt(s)");
  expect(write.calls()).toHaveLength(1);
});

test("an option value before the endpoint is not the endpoint", () => {
  const setup = fixture(["unexpected end of JSON input"]);
  const result = setup.run(["api", "-H", "Accept: application/vnd.github+json", "repos/owner/repo/pulls/7/reviews"]);
  expect(result.exitCode).toBe(0);
  expect(setup.calls()).toHaveLength(2);
});

test("a GraphQL document keeps the write guard unless it opens with query", () => {
  const commented = fixture(["unexpected end of JSON input"]);
  expect(commented.run(["api", "graphql", "-f", "query=# note\nquery { viewer { login } }"]).exitCode).toBe(0);
  const fragment = fixture(["unexpected end of JSON input"]);
  const result = fragment.run(["api", "graphql", "-f", "query=fragment F on User { login } mutation { example }"]);
  expect(result.exitCode).toBe(1);
  expect(fragment.calls()).toHaveLength(1);
});

test("a read that returns an empty body retries, since the request changed nothing", () => {
  const setup = fixture(["unexpected end of JSON input"]);
  const result = setup.run(["api", "graphql", "-f", "query={viewer{login}}"]);
  expect(result.exitCode).toBe(0);
  expect(setup.calls()).toHaveLength(2);
  expect(setup.delays()).toEqual([1]);
});

test("a GraphQL read stays a read when a field value mentions mutation", () => {
  const setup = fixture(["unexpected end of JSON input"]);
  const result = setup.run(["api", "graphql", "-f", 'query=query{repository(owner:"owner",name:"mutation-testing"){id}}']);
  expect(result.exitCode).toBe(0);
  expect(setup.calls()).toHaveLength(2);
  expect(setup.delays()).toEqual([1]);
});

test.each([
  [["api", "repos/owner/repo/pulls/7/reviews", "--input", "-"], "{}"],
  // A REST field flag makes the call a POST even without --input or -X.
  [["api", "repos/owner/repo/check-runs", "-f", "name=code-review"], ""],
  // A GraphQL document that mutates is a write too.
  [["api", "graphql", "-f", "query=mutation { resolveReviewThread(input: {threadId: \"t\"}) { thread { isResolved } } }"], ""],
  // A REST call stays REST when a field value happens to contain `graphql`, as the hosted check-run call can.
  [["api", "repos/owner/repo/check-runs", "-f", "external_id=weekly graphql review", "-f", "name=code-review"], ""],
])("a write that returns an empty body stops instead of duplicating itself: %j", (args, input) => {
  const setup = fixture(["unexpected end of JSON input"]);
  const result = setup.run(args, input);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain(`retry.sh: failed after 1 attempt(s): gh ${args.join(" ")}\n`);
  expect(setup.calls()).toHaveLength(1);
  expect(setup.delays()).toEqual([]);
});

test("an explicit GET keeps field flags a read", () => {
  const setup = fixture(["unexpected end of JSON input"]);
  const result = setup.run(["api", "repos/owner/repo/pulls/7/reviews", "--method", "GET", "-f", "per_page=100"]);
  expect(result.exitCode).toBe(0);
  expect(setup.calls()).toHaveLength(2);
  expect(setup.delays()).toEqual([1]);
});

test("a GraphQL server error retries", () => {
  const setup = fixture(["GraphQL: Something went wrong while executing your query on 2026-11-25T16:14:45Z. Please include `8884:37234` when reporting this issue."]);
  expect(setup.run().exitCode).toBe(0);
  expect(setup.calls()).toHaveLength(2);
  expect(setup.delays()).toEqual([1]);
});

test.each([
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

test.each([
  'gh: You have exceeded a secondary rate limit. Please wait a few minutes before you try again. (HTTP 403)',
  'gh: You have triggered an abuse detection mechanism. Please wait a few minutes before you try again. (HTTP 403)',
  'gh: You have exceeded a secondary rate limit. Please wait a few minutes before you try again. (HTTP 429)',
  'gh: Too Many Requests (HTTP 429)',
])("rate limits retry after at least a minute and replay stdin: %s", error => {
  const setup = fixture([error]);
  const args = ["api", "graphql", "--input", "-"];
  const input = '{"query":"mutation { example }"}';
  const result = setup.run(args, input);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe("ok\n");
  expect(setup.calls()).toEqual([{ args, input }, { args, input }]);
  expect(setup.delays()).toEqual([60]);
});

test("persistent rate limits exhaust eight attempts with capped backoff", () => {
  const setup = fixture(Array(8).fill("gh: You have exceeded a secondary rate limit. (HTTP 403)"));
  expect(setup.run().exitCode).toBe(1);
  expect(setup.calls()).toHaveLength(8);
  expect(setup.delays()).toEqual([60, 120, 240, 300, 300, 300, 300]);
});

test("a permission error after a rate limit stops further retries", () => {
  const setup = fixture(['gh: You have exceeded a secondary rate limit. (HTTP 403)', 'gh: Resource not accessible by integration (HTTP 403)']);
  const result = setup.run();
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout.toString())).toEqual({ message: 'gh: Resource not accessible by integration (HTTP 403)' });
  expect(setup.calls()).toHaveLength(2);
  expect(setup.delays()).toEqual([60]);
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

test.each([undefined, ""])("review thread lookup rejects missing PR_NUMBER (%j) before calling gh", pr => {
  const setup = fixture([]);
  const result = Bun.spawnSync(["bash", join(scripts, "review-threads.sh"), "lookup", "123"], { env: { ...setup.env, PR_NUMBER: pr }, timeout: 3000 });
  expect(setup.calls()).toEqual([]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("PR_NUMBER");
});
