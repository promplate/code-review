import { afterEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const scripts = import.meta.dir, root = resolve(scripts, "..");
const dirs: string[] = [], children: ReturnType<typeof Bun.spawn>[] = [];
const stop = "test-log-command-token";
const stripColors = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
const input = (records: object[]) => Buffer.from(records.map(record => JSON.stringify(record)).join("\n") + "\n");

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) { child.kill(); await child.exited; }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "review-log-mux-"));
  dirs.push(dir);
  writeFileSync(join(dir, "injected.rendered"), "");
  return dir;
}

function formatter(name: "codex" | "injected", framed = true) {
  return ["jq", "--unbuffered", framed ? "-c" : "-r", "--arg", "stop", stop, "-f", join(scripts, `${name}-log.jq`)];
}

function render(name: "codex" | "injected", records: object[], framed = false, hosted = "") {
  const result = Bun.spawnSync(formatter(name, framed), {
    env: { ...process.env, REVIEW_HOSTED: hosted }, stdin: input(records),
  });
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe("");
  return result.stdout;
}

function mux(dir: string, drain = false) {
  const child = Bun.spawn([process.execPath, `--config=${join(scripts, "review-bun.toml")}`, join(scripts, "log-mux.mjs"), ...(drain ? ["--drain"] : [])], {
    env: { ...process.env, RUNNER_TEMP: dir, GITHUB_ACTION_PATH: root },
    stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: 8000,
  });
  children.push(child);
  let output = "";
  const stdout = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout) output += decoder.decode(chunk, { stream: true });
    output += decoder.decode();
  })();
  const stderr = new Response(child.stderr).text();
  return {
    child, output: () => output,
    finish: async (success = true) => {
      child.stdin.end();
      const code = await child.exited;
      await stdout;
      if (success) {
        expect(code).toBe(0);
        expect(await stderr).toBe("");
      } else {
        expect(code).not.toBe(0);
        expect((await stderr).length).toBeGreaterThan(0);
      }
      return output;
    },
  };
}

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the live log");
    await Bun.sleep(10);
  }
}

const activity = (id: number, size = 0) => ({
  event: "issue_comment", action: "created", sender: { login: "alice%0A\n::error::title", type: "User" },
  comment: { id, body: `activity-${id}: literal:\u200b: \\:: \\u003a ${"字🙂x".repeat(size)}\n\u0000 ::error::forged\n##[error]forged\n::group::forged\n::endgroup::`, html_url: `/pull/7#issuecomment-${id}` },
  workflow: "display-only workflow",
});
const tool = (id: number, size = 0) => ({ type: "item.completed", item: {
  type: "command_execution", command: `bash -lc 'tool-${id}'`,
  aggregated_output: `tool-${id}-begin\n${"字🙂x".repeat(size)}\u0000\n::error::forged-${id}\n##[error]forged-${id}\n::group::forged-${id}\n::endgroup::\ntool-${id}-end\n`,
} });

// Model the runner's command state, so a payload's fake group markers do not hide a lost
// stop/resume token or make an activity group appear nested inside a tool's output.
function groups(output: string) {
  const result: { title: string; body: string[] }[] = [];
  let current: typeof result[number] | undefined, token: string | undefined;
  for (const line of stripColors(output).split("\n")) {
    if (token) {
      if (line === `::${token}::`) token = undefined;
      else current?.body.push(line);
    } else if (line.startsWith("::group::")) {
      expect(current === undefined).toBe(true);
      current = { title: line.slice("::group::".length), body: [] };
    } else if (line.startsWith("::stop-commands::")) {
      expect(current !== undefined).toBe(true);
      token = line.slice("::stop-commands::".length);
    } else if (line === "::endgroup::") {
      expect(current !== undefined).toBe(true);
      result.push(current!);
      current = undefined;
    } else {
      expect(/^\s*::|##\[/.test(line)).toBe(false);
      if (current) current.body.push(line);
      else expect(line).toBe("");
    }
  }
  expect(current === undefined && token === undefined).toBe(true);
  return result;
}

test.each(["", "true"])("concurrent production formatters preserve large records and runner commands (hosted=%j)", async hosted => {
  const dir = fixture(), log = mux(dir);
  // Each record is much larger than PIPE_BUF; both streams contain multibyte text,
  // newlines, NUL and command-looking data. They must survive byte-chunk boundaries.
  const activities = [activity(1, 1024), activity(2, 2560), activity(3, 1024), activity(4, 2560)];
  const tools = [tool(1, 24000), tool(2, 24000), tool(3, 24000), tool(4, 24000)];
  const producer = (name: "codex" | "injected", records: object[]) => {
    const child = Bun.spawn(formatter(name), {
      env: { ...process.env, REVIEW_HOSTED: hosted }, stdin: input(records), stdout: "pipe", stderr: "pipe",
    });
    children.push(child);
    return child;
  };
  const toolWriter = producer("codex", tools), activityWriter = producer("injected", activities);
  const pump = async (child: typeof toolWriter, write: (bytes: Uint8Array) => void | Promise<unknown>) => {
    const stderr = new Response(child.stderr).text();
    for await (const chunk of child.stdout) {
      for (let position = 0; position < chunk.length; position += 1019) {
        await write(chunk.subarray(position, position + 1019));
        await Bun.sleep(1);
      }
    }
    expect(await child.exited).toBe(0);
    expect(await stderr).toBe("");
  };
  await Promise.all([
    pump(toolWriter, async bytes => { log.child.stdin.write(bytes); await log.child.stdin.flush(); }),
    pump(activityWriter, bytes => appendFileSync(join(dir, "injected.rendered"), bytes)),
  ]);
  const output = await log.finish();
  // Comparing with raw production formatter output also detects changes to whitespace,
  // Unicode, escaping and command tokens; removing each once proves no extra output.
  let remainder = output;
  for (const [name, records] of [["codex", tools], ["injected", activities]] as const) {
    for (const record of records) {
      const rendered = render(name, [record], false, hosted).toString();
      const position = remainder.indexOf(rendered);
      expect(position).toBeGreaterThanOrEqual(0);
      remainder = remainder.slice(0, position) + remainder.slice(position + rendered.length);
    }
  }
  expect(remainder.length).toBe(0);
  const blocks = groups(output);
  expect(blocks).toHaveLength(tools.length + activities.length);
  const activityGroups = blocks.filter(block => block.title.startsWith("issue_comment/created"));
  expect(activityGroups.map(block => JSON.parse(block.body.join("\n")).comment.id)).toEqual([1, 2, 3, 4]);
  activityGroups.forEach((block, index) => {
    const { workflow, ...expected } = activities[index];
    expect(JSON.parse(block.body.join("\n"))).toEqual(expected);
    expect(block.title).toContain(hosted ? "alice%0A " : "alice%250A ");
  });
  const toolGroups = blocks.filter(block => block.title.startsWith("$ tool-"));
  expect(toolGroups.map(block => block.title)).toEqual(["$ tool-1", "$ tool-2", "$ tool-3", "$ tool-4"]);
  toolGroups.forEach((block, index) => expect(block.body.join("\n") === tools[index].item.aggregated_output.replace(/\n$/, "")).toBe(true));
  expect(Number(readFileSync(join(dir, "injected.offset"), "utf8"))).toBe(readFileSync(join(dir, "injected.rendered")).length);
}, 15000);

test("only complete activity records appear while a tool record is unfinished and stdin is idle", async () => {
  const dir = fixture(), log = mux(dir);
  const event = activity(10, 5000), command = tool(10, 24000);
  const eventBytes = render("injected", [event], true), toolBytes = render("codex", [command], true);
  // Split inside a UTF-8 character rather than only on ASCII/JSON boundaries.
  const split = eventBytes.indexOf(Buffer.from("🙂")) + 1;
  expect(split).toBeGreaterThan(1);
  appendFileSync(join(dir, "injected.rendered"), eventBytes.subarray(0, split));
  log.child.stdin.write(toolBytes.subarray(0, 4097));
  await log.child.stdin.flush();
  await Bun.sleep(150);
  expect(log.output()).toBe("");
  appendFileSync(join(dir, "injected.rendered"), eventBytes.subarray(split, -1));
  await Bun.sleep(150);
  expect(log.output()).toBe("");
  // A final newline commits the frame; no tool write or EOF wakes the reader.
  appendFileSync(join(dir, "injected.rendered"), eventBytes.subarray(-1));
  const expectedEvent = render("injected", [event]).toString();
  await until(() => log.output() === expectedEvent);
  expect(log.child.exitCode).toBeNull();
  log.child.stdin.write(toolBytes.subarray(4097));
  const output = await log.finish();
  expect(output === expectedEvent + render("codex", [command]).toString()).toBe(true);
});

test("retry, resume and the final drain share a byte cursor through complete records only", async () => {
  const dir = fixture(), path = join(dir, "injected.rendered");
  const events = [activity(21, 2048), activity(22, 5000), activity(23, 2048)];
  const bytes = events.map(event => render("injected", [event], true));
  const expected = events.map(event => render("injected", [event]).toString());
  const cursor = () => existsSync(join(dir, "injected.offset")) ? Number(readFileSync(join(dir, "injected.offset"), "utf8")) : 0;
  appendFileSync(path, Buffer.concat([bytes[0], bytes[1].subarray(0, 4097)]));
  const first = mux(dir);
  expect(await first.finish() === expected[0]).toBe(true);
  expect(cursor()).toBe(bytes[0].length);
  appendFileSync(path, bytes[1].subarray(4097));
  const resumed = mux(dir);
  await until(() => resumed.output() === expected[1]);
  appendFileSync(path, bytes[2].subarray(0, 4097));
  expect(await resumed.finish() === expected[1]).toBe(true);
  expect(cursor()).toBe(bytes[0].length + bytes[1].length);
  // The worker completes this last record only after the last tool pipeline exits.
  appendFileSync(path, bytes[2].subarray(4097));
  expect(await mux(dir, true).finish() === expected[2]).toBe(true);
  expect(cursor()).toBe(bytes.reduce((total, record) => total + record.length, 0));
  expect(await mux(dir, true).finish()).toBe("");
});

test("a truncated final activity is reported without emitting or consuming it", async () => {
  const dir = fixture(), path = join(dir, "injected.rendered");
  const first = activity(31), last = activity(32, 20000);
  const firstBytes = render("injected", [first], true), lastBytes = render("injected", [last], true);
  appendFileSync(path, Buffer.concat([firstBytes, lastBytes.subarray(0, -1)]));
  expect(await mux(dir, true).finish(false) === render("injected", [first]).toString()).toBe(true);
  expect(Number(readFileSync(join(dir, "injected.offset"), "utf8"))).toBe(firstBytes.length);
  appendFileSync(path, lastBytes.subarray(-1));
  expect(await mux(dir, true).finish() === render("injected", [last]).toString()).toBe(true);
});

test.each(["{broken}\n", "123\n", JSON.stringify("unfinished tool record\n")])("invalid or unfinished tool framing cannot leak into the visible log (%j)", async frame => {
  const log = mux(fixture());
  log.child.stdin.write(frame);
  expect(await log.finish(false)).toBe("");
});

test("a malformed activity during tool idle exits without consuming later records", async () => {
  const dir = fixture(), log = mux(dir), path = join(dir, "injected.rendered");
  const first = activity(41), later = activity(42);
  const firstBytes = render("injected", [first], true), expected = render("injected", [first]).toString();
  appendFileSync(path, firstBytes);
  await until(() => log.output() === expected);
  appendFileSync(path, Buffer.concat([Buffer.from("{broken}\n"), render("injected", [later], true)]));
  // Keep tool stdin open: the independent activity timer must report this failure.
  await until(() => log.child.exitCode !== null);
  expect(log.child.exitCode).toBe(1);
  expect(await log.finish(false) === expected).toBe(true);
  expect(Number(readFileSync(join(dir, "injected.offset"), "utf8"))).toBe(firstBytes.length);
});

test("the production patch bridge preserves long Unicode stderr through JSON formatting", async () => {
  const stderr = "raw stderr: " + "字🙂x".repeat(24000) + "\u0000 end";
  const bridge = Bun.spawnSync([process.execPath, `--config=${join(scripts, "review-bun.toml")}`, join(scripts, "codex-patches.mjs")], {
    stdin: Buffer.from(stderr + "\n"), env: { ...process.env, CODEX_HOME: "" },
  });
  expect(bridge.exitCode).toBe(0);
  const record = JSON.parse(bridge.stdout.toString());
  expect(record.type).toBe("error");
  expect(record.message === stderr).toBe(true);
  const formatted = Bun.spawnSync(formatter("codex"), { stdin: bridge.stdout });
  expect(formatted.exitCode).toBe(0);
  const log = mux(fixture());
  log.child.stdin.write(formatted.stdout);
  expect(await log.finish() === stderr + "\n\n").toBe(true);
});
