import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const scripts = process.env.REVIEW_SCRIPTS_PATH || import.meta.dir;
const homes: string[] = [];
afterEach(() => { for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(errors: string[], policy = "--idempotent", errorBody?: string) {
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
  console.log(process.env.ERROR_BODY ?? JSON.stringify({ message: errors[count] }));
  console.error(errors[count]);
  process.exit(1);
}
console.log("ok");
console.error("success diagnostic");
`, { mode: 0o755 });
  writeFileSync(join(dir, "sleep"), '#!/bin/sh\nprintf "%s\\n" "$1" >> "$RUNNER_TEMP/delays"\n', { mode: 0o755 });
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, RUNNER_TEMP: dir, ERRORS: JSON.stringify(errors), ERROR_BODY: errorBody, GITHUB_ACTION_PATH: resolve(scripts, ".."), GITHUB_REPOSITORY: "owner/repo" };
  return { dir, env,
    calls: () => existsSync(join(dir, "calls")) ? readFileSync(join(dir, "calls"), "utf8").trim().split("\n").map(line => JSON.parse(line)) : [],
    delays: () => existsSync(join(dir, "delays")) ? readFileSync(join(dir, "delays"), "utf8").trim().split("\n").map(Number) : [],
    run: (args = ["api", "graphql"], input = "") => Bun.spawnSync(["bash", join(scripts, "retry.sh"), ...(policy ? [policy] : []), "gh", ...args], { env, stdin: Buffer.from(input), timeout: 3000 }),
  };
}

test("a retryable GET can return an error body beginning with an HTTP status line", () => {
  const setup = fixture(["gh: Bad Gateway (HTTP 502)"], "--idempotent", "HTTP/1.1 422 Unprocessable Content\r\nupstream unavailable");
  const result = setup.run(["api", "repos/owner/repo"]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe("ok\n");
  expect(setup.delays()).toEqual([1]);
});

test("a lost progress update lets the tool run after one attempt", () => {
  const setup = fixture(["unexpected EOF"]);
  const result = Bun.spawnSync(["bash", join(scripts, "review-hook.sh")], {
    env: { ...setup.env, CHECK_ID: "10" }, timeout: 3000,
    stdin: Buffer.from(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } })),
  });
  expect(result.exitCode).toBe(0);
  expect(setup.calls()).toHaveLength(1);
  const [call] = setup.calls();
  expect(call.args).toEqual(["api", "repos/owner/repo/check-runs/10", "-X", "PATCH", "--input", "-"]);
  expect(JSON.parse(call.input).output.summary).toContain("ls");
  expect(setup.delays()).toEqual([]);
});

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

test.each([
  [["api", "repos/owner/repo/pulls/7/reviews", "--input", "-"], "{}"],
  [["api", "repos/owner/repo/pulls/7/reviews", "--input=-"], "{}"],
  [["api", "repos/owner/repo/check-runs", "--raw-field=name=code-review"], ""],
  [["api", "graphql", "--input=-"], '{"query":"mutation { example }"}'],
  [["api", "graphql", "--raw-field=query=mutation { example }"], ""],
  [["api", "repos/owner/repo/pulls/7/reviews", "--method=GET", "-XPOST", "-f", "body=Reviewed"], ""],
  [["api", "repos/owner/repo/check-runs/7", "-X", "PATCH", "--input", "-"], '{"output":{"annotations":[{}]}}'],
  ...["mutation Submit", "mutation,Submit", "mutation# note\nSubmit"].flatMap(operation => {
    const query = "query Read { viewer { login } }";
    const mutation = `${operation} { addComment { id } }`;
    return [`${query} ${mutation}`, `${mutation} ${query}`].map(document =>
      [["api", "graphql", "--raw-field=query=" + document, "-f", "operationName=Submit"], ""]);
  }),
] as [string[], string][])("an undeclared operation never replays an unreadable response: %j", (args, input) => {
  const setup = fixture(["unexpected end of JSON input"], "");
  const result = setup.run(args, input);
  expect(result.exitCode).toBe(1);
  expect(setup.calls()).toEqual([{ args, input }]);
  expect(setup.delays()).toEqual([]);
  expect(result.stderr.toString()).toContain("retry.sh: failed after 1 attempt(s):");
});

test.each([
  "unexpected EOF", "read tcp: connection reset by peer", "i/o timeout",
  "gh: HTTP 502", "gh: HTTP 503", "gh: HTTP 504",
  "GraphQL: Something went wrong while executing your query",
  "gh: Too Many Requests (HTTP 429)",
])("an undeclared write never replays after %s", error => {
  const setup = fixture([error], "");
  const args = ["api", "graphql", "--input", "-"];
  const input = '{"query":"mutation { example }"}';
  expect(setup.run(args, input).exitCode).toBe(1);
  expect(setup.calls()).toEqual([{ args, input }]);
  expect(setup.delays()).toEqual([]);
});

test.each([
  ["api", "repos/owner/repo/actions/artifacts", "--method=GET", "--field=per_page=100"],
  ["api", "graphql", "--raw-field=query=query($n: String!) { viewer { login } }"],
  ["api", "graphql", "-f", 'query=query { search(query:"mutation testing",type:ISSUE,first:1){issueCount} }'],
  ["api", "graphql", "-f", "query=query Read { viewer { login } } mutation Submit { addComment { id } }", "-f", "operationName=Read"],
  ["api", "graphql", "-f", "query=mutation { resolveReviewThread { thread { isResolved } } }"],
])("a declared idempotent operation retries without inspecting its arguments: %j", (...args) => {
  const setup = fixture(["unexpected end of JSON input"]);
  const result = setup.run(args);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe("ok\n");
  expect(setup.calls()).toEqual([{ args, input: "" }, { args, input: "" }]);
  expect(setup.delays()).toEqual([1]);
});

test("an undeclared command wrapped in bash also executes only once", () => {
  const setup = fixture(["unexpected EOF"], "");
  const result = Bun.spawnSync(["bash", join(scripts, "retry.sh"), "bash", "-c", 'gh api graphql --input=-'], { env: setup.env, stdin: Buffer.from("{}"), timeout: 3000 });
  expect(result.exitCode).toBe(1);
  expect(setup.calls()).toHaveLength(1);
  expect(setup.delays()).toEqual([]);
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
  const input = '{"query":"query { viewer { login } }"}';
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
  const input = '{"query":"query { viewer { login } }"}';
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

test("only a declared idempotent delete treats 404 as success", () => {
  const args = ["api", "repos/owner/repo/reactions/1", "-X", "DELETE"];
  for (const [policy, exitCode] of [["", 1], ["--idempotent", 1], ["--idempotent-delete", 0]] as const) {
    const setup = fixture(["gh: Not Found (HTTP 404)"], policy);
    expect(setup.run(args).exitCode).toBe(exitCode);
    expect(setup.calls()).toHaveLength(1);
    expect(setup.delays()).toEqual([]);
  }
  const retry = fixture(["unexpected EOF", "gh: Not Found (HTTP 404)"], "--idempotent-delete");
  expect(retry.run(args).exitCode).toBe(0);
  expect(retry.calls()).toHaveLength(2);
  expect(retry.delays()).toEqual([1]);
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
