import { Database } from "bun:sqlite";
import { appendFileSync, existsSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

const [event, size] = process.argv.slice(2);
const dir = process.env.RUNNER_TEMP;
const receipts = join(dir, "injected-deliveries.log");
// Bun already ships SQLite on every runner. Its OS lock survives neither normal
// exit nor SIGKILL; keep the file so contenders always lock the same inode.
const lock = new Database(join(dir, "injected-deliveries.sqlite"));
try {
  lock.exec("PRAGMA busy_timeout = 5000");
  try {
    lock.exec("BEGIN IMMEDIATE");
  } catch (error) {
    if (error.code === "SQLITE_BUSY") throw new Error("Timed out waiting for the review hook delivery lock");
    throw error;
  }
  const seen = existsSync(receipts) ? readFileSync(receipts, "utf8").split("\n").filter(Boolean) : [];
  // A child may outlive a killed owner, so it only computes into a captured pipe:
  // only this process can publish context or record its receipt while holding the lock.
  const child = Bun.spawn(["jq", "-Rrs", "--arg", "pr", process.env.PR_NUMBER || "", "--argjson", "seen", JSON.stringify(seen),
    "-f", join(import.meta.dir, "review-hook.jq"), join(dir, "sse.jsonl")], { stdin: "ignore", stdout: "pipe", stderr: "inherit" });
  const result = await new Response(child.stdout).json();
  if (await child.exited !== 0) throw new Error("Could not read review activity");
  const lines = values => values.length ? values.join("\n") + "\n" : "";
  // The live log is best effort and is not a delivery receipt.
  const log = join(dir, "injected.log");
  if (existsSync(log)) {
    try { appendFileSync(log, lines(result.delivered.map(value => JSON.stringify(value)))); } catch {}
  }
  if (result.context) {
    const issue = process.env.AGENT === "true" && process.env.ISSUE_NUMBER;
    const subject = issue ? `issue #${issue}` : process.env.PR_NUMBER ? `PR #${process.env.PR_NUMBER}` : `branch ${process.env.HEAD_BRANCH}`;
    const instruction = issue ? "Continue working on the issue and reply there when useful."
      : "Take it into account, answer each message where it was posted when useful, and output the JSON review covering what this run saw.";
    const message = `New GitHub activity on ${subject}:\n${result.context}\n${instruction}`;
    const output = Buffer.from(JSON.stringify(event === "Stop" ? { decision: "block", reason: message }
      : { hookSpecificOutput: { hookEventName: event, additionalContext: message } }, null, 2) + "\n");
    // Complete stdout before acknowledging delivery, including partial writes.
    for (let offset = 0; offset < output.length;) offset += writeSync(1, output, offset, output.length - offset);
  }
  // A crash after output may repeat an event, but cannot suppress an undelivered one.
  appendFileSync(receipts, lines(result.fresh));
  writeFileSync(join(dir, "injected.size"), size + "\n");
} finally {
  lock.close();
}
