import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, ".."), dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture({ failReply = false, failReads = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "review-threads-"));
  dirs.push(dir);
  const thread = (id: string, resolved: boolean) => ({
    id: "thread-" + id, path: "a.py", line: resolved ? null : 5, isResolved: resolved,
    isOutdated: resolved, resolvedBy: resolved ? { login: "writer" } : null,
    comments: { nodes: [{ fullDatabaseId: id, body: "Finding", author: { login: "reviewer" } }] },
  });
  const page = (node: ReturnType<typeof thread>) => JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [node] } } } } });
  writeFileSync(join(dir, "pages"), [page(thread("4577300937", true)), page(thread("4577334863", false))].join("\n"));
  writeFileSync(join(dir, "writes"), "");
  writeFileSync(join(dir, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(dir, "gh"), `#!/bin/sh
if [ "$FAIL_READS" = true ]; then
  case "$*" in
    *'reviewThreads(first:'*) marker=graphql ;;
    *pulls/comments/*) marker=rest ;;
    *) marker= ;;
  esac
  if [ -n "$marker" ] && [ ! -f "$FIXTURE/$marker" ]; then
    touch "$FIXTURE/$marker"
    echo '{"message":"Service Unavailable"}'
    echo 'gh: HTTP 503' >&2
    exit 1
  fi
fi
case "$*" in
  *'reviewThreads(first: 100, after: $endCursor)'*)
    case " $* " in *" -F number=$PR_NUMBER "*) ;; *) exit 1 ;; esac
    case "$*" in *--paginate*) cat "$FIXTURE/pages" ;; *) head -n1 "$FIXTURE/pages" ;; esac ;;
  *pulls/comments/4577300937*|*pulls/comments/4577369868*) echo 4577300937 ;;
  *pulls/comments/4577337965*) echo 4577334863 ;;
  *pulls/comments/999*) echo 999 ;;
  *'mutation('*)
    printf '%s\\n' "$@" >> "$FIXTURE/writes"
    case "$*" in *addPullRequestReviewThreadReply*) exit ${failReply ? 1 : 0} ;; esac ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  const env = { ...process.env, PATH: dir + ":" + process.env.PATH, FIXTURE: dir, GITHUB_ACTION_PATH: root,
    GITHUB_REPOSITORY: "owner/repo", PR_NUMBER: "82", FAIL_READS: String(failReads) };
  const run = (script: string, ...args: string[]) => Bun.spawnSync(["bash", join(import.meta.dir, script), ...args], { env });
  return { run: (...args: string[]) => run("review-threads.sh", ...args), legacy: (...args: string[]) => run("resolve-thread.sh", ...args),
    writes: () => readFileSync(join(dir, "writes"), "utf8") };
}

test("list and lookup include open and resolved threads across pages", () => {
  const f = fixture();
  expect(JSON.parse(f.run("list").stdout.toString())).toEqual([true, false].map((resolved, i) => {
    const id = ["4577300937", "4577334863"][i];
    return { threadId: "thread-" + id, path: "a.py", line: resolved ? null : 5, isResolved: resolved, isOutdated: resolved,
      resolvedBy: resolved ? "writer" : null, firstComment: { id, body: "Finding", author: "reviewer" } };
  }));
  for (const [comment, rootId] of [["4577300937", "4577300937"], ["4577369868", "4577300937"], ["4577337965", "4577334863"]]) {
    expect(f.run("lookup", comment).stdout.toString().trim()).toBe("thread-" + rootId);
  }
  expect(f.run("lookup", "999").exitCode).not.toBe(0);
  expect(f.run("resolve", "another-pr", "--reply", "Fixed").exitCode).not.toBe(0);
  expect(f.writes()).toBe("");
});

test("resolve by comment replies once, and thread IDs can change state without a reply", () => {
  const f = fixture();
  expect(f.legacy("4577337965", "Fixed in abc").exitCode).toBe(0);
  expect(f.run("unresolve", "thread-4577334863").exitCode).toBe(0);
  expect(f.run("resolve", "thread-4577334863").exitCode).toBe(0);
  const writes = f.writes();
  expect(writes.match(/\w+\(input:/g)).toEqual(["addPullRequestReviewThreadReply(input:", "resolveReviewThread(input:",
    "unresolveReviewThread(input:", "resolveReviewThread(input:"]);
  expect(writes.match(/^id=thread-4577334863$/gm)).toHaveLength(4);
  expect(writes).toContain("body=Fixed in abc\n");
});

test("a failed reply stops resolution and is never retried", () => {
  const f = fixture({ failReply: true });
  expect(f.run("resolve", "thread-4577334863", "--reply", "Fixed").exitCode).not.toBe(0);
  expect(f.writes().match(/\w+\(input:/g)).toEqual(["addPullRequestReviewThreadReply(input:"]);
});

test("resolution recovers from transient REST and GraphQL read failures before posting the reply", () => {
  const f = fixture({ failReads: true });
  expect(f.legacy("4577337965", "Fixed").exitCode).toBe(0);
  expect(f.writes().match(/\w+\(input:/g)).toEqual(["addPullRequestReviewThreadReply(input:", "resolveReviewThread(input:"]);
});
