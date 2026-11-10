import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const action = Bun.YAML.parse(readFileSync(process.env.REVIEW_ACTION_PATH || join(root, "action.yml"), "utf8")) as any;
const script = action.runs.steps.find((step: any) => step.name === "Publish potential issues").run.replaceAll("${{ github.repository }}", "owner/repo");
const homes: string[] = [];
const marker = "<!-- code-review:potential-issues -->";
const heading = "Worth checking — I could not settle these from the diff alone:";
const issue = { path: "a.ts", line: 1, issue: "Possible failure.", check: "Run the example." };
const body = `${marker}\n\n${heading}\n\n- \`a.ts:1\` — Possible failure. Check: Run the example.`;
const comment = (id: number, body: string, login = "reviewer[bot]") => ({ id, body, user: { login } });

function run(comments: ReturnType<typeof comment>[], issues = [issue], failure = "") {
  const dir = mkdtempSync(join(tmpdir(), "review-potential-issues-"));
  homes.push(dir);
  writeFileSync(join(dir, "state.json"), JSON.stringify(comments));
  writeFileSync(join(dir, "review.json"), JSON.stringify({ potential_issues: issues }));
  writeFileSync(join(dir, "calls"), "");
  writeFileSync(join(dir, "gh"), `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const dir = process.env.RUNNER_TEMP, args = process.argv.slice(2);
let state = JSON.parse(readFileSync(dir + "/state.json", "utf8"));
const endpoint = args.find(arg => arg.startsWith("repos/"));
const method = args.includes("-X") ? args[args.indexOf("-X") + 1] : args.includes("--input") ? "POST" : "GET";
appendFileSync(dir + "/calls", JSON.stringify({ method, endpoint }) + "\\n");
if (method === "GET") {
  if (process.env.FAIL_READ === "always") process.exit(1);
  for (let i = 0; i < state.length || i === 0; i += 100) {
    const page = state.slice(i, i + 100);
    if (args.includes("--jq")) for (const entry of page) console.log(JSON.stringify(entry));
    else console.log(JSON.stringify(page));
    if (process.env.FAIL_READ === "partial" && !existsSync(dir + "/retried")) {
      writeFileSync(dir + "/retried", "1");
      process.exit(1);
    }
    if (!args.includes("--paginate")) break;
  }
} else {
  const id = Number(endpoint.split("/").at(-1));
  const payload = args.includes("--input") ? JSON.parse(readFileSync(args[args.indexOf("--input") + 1], "utf8")) : {};
  if (method === "POST") state.push({ id: Math.max(0, ...state.map(c => c.id)) + 1, user: { login: "reviewer[bot]" }, ...payload });
  if (method === "PATCH") state = state.map(c => c.id === id ? { ...c, ...payload } : c);
  if (method === "DELETE") state = state.filter(c => c.id !== id);
  writeFileSync(dir + "/state.json", JSON.stringify(state));
}
`);
  chmodSync(join(dir, "gh"), 0o755);
  // Exercise the real retry loop without waiting through its backoff.
  writeFileSync(join(dir, "sleep"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(dir, "sleep"), 0o755);
  const result = Bun.spawnSync(["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", script], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, RUNNER_TEMP: dir, GITHUB_ACTION_PATH: root,
      PR_NUMBER: "7", BOT_LOGIN: "reviewer[bot]", FAIL_READ: failure }, timeout: 5000,
  });
  return { result, state: JSON.parse(readFileSync(join(dir, "state.json"), "utf8")),
    calls: readFileSync(join(dir, "calls"), "utf8").trim().split("\n").map(line => JSON.parse(line)) };
}

afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("creates, updates and adopts the potential-issues comment", () => {
  for (const comments of [[], [comment(1, marker + "\nold")], [comment(1, heading + "\n\nold")]]) {
    const { result, state } = run(comments);
    expect(result.exitCode).toBe(0);
    expect(state).toEqual([comment(1, body)]);
  }
});

test("an unchanged list makes no write", () => {
  const { result, calls } = run([comment(1, body)]);
  expect(result.exitCode).toBe(0);
  expect(calls.map(call => call.method)).toEqual(["GET"]);
});

test("finds the existing comment beyond the first page", () => {
  const preceding = Array.from({ length: 100 }, (_, i) => comment(i + 1, "Discussion", "human"));
  const { result, state } = run([...preceding, comment(101, marker + "\nold")]);
  expect(result.exitCode).toBe(0);
  expect(state).toEqual([...preceding, comment(101, body)]);
});

test("a failed lookup makes no writes", () => {
  const comments = [comment(1, body)];
  const { result, state, calls } = run(comments, [issue], "always");
  expect(result.exitCode).not.toBe(0);
  expect(state).toEqual(comments);
  expect(calls.every(call => call.method === "GET")).toBe(true);
});

test("a retried partial lookup does not delete the tracked comment", () => {
  const { result, state, calls } = run([comment(1, body)], [issue], "partial");
  expect(result.exitCode).toBe(0);
  expect(state).toEqual([comment(1, body)]);
  expect(calls.every(call => call.method === "GET")).toBe(true);
});

test("consolidates legacy copies and clears all copies when settled", () => {
  const comments = [comment(1, heading + "\n\nold"), comment(2, heading + "\n\nnew")];
  for (const input of [comments, comments.toReversed()]) {
    const updated = run(input);
    expect(updated.result.exitCode).toBe(0);
    expect(updated.state).toEqual([comment(2, body)]);
    const cleared = run(input, []);
    expect(cleared.result.exitCode).toBe(0);
    expect(cleared.state).toEqual([]);
  }
});

test("preserves unrelated comments and comments from other authors", () => {
  const comments = [comment(1, "Worth checking the migration guide."), comment(2, body, "another[bot]"), comment(3, `The marker is \`${marker}\`.`)];
  const { result, state } = run(comments, []);
  expect(result.exitCode).toBe(0);
  expect(state).toEqual(comments);
});
