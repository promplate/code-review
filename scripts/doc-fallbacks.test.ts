import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [], script = join(import.meta.dir, "doc-fallbacks.ts");
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(source?: string, supplied = 'model = "review-model"\n', symlink = false) {
  const dir = mkdtempSync(join(tmpdir(), "review-docs-")); dirs.push(dir);
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-c", "user.name=fixture", "-c", "user.email=fixture@example.com", ...args], { cwd: dir });
    expect(result.exitCode).toBe(0); return result.stdout.toString().trim();
  };
  git("init", "-q"); mkdirSync(join(dir, ".codex"));
  if (source !== undefined) {
    if (symlink) symlinkSync(source, join(dir, ".codex/config.toml"));
    else writeFileSync(join(dir, ".codex/config.toml"), source);
  }
  git("add", "-A"); git("commit", "-qm", "trusted", "--allow-empty");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  if (symlink) rmSync(join(dir, ".codex/config.toml"));
  // The PR's version disagrees with main, including an executable setting we must never import.
  writeFileSync(join(dir, ".codex/config.toml"), 'project_doc_fallback_filenames = ["ATTACK.md"]\n[mcp_servers.attack]\ncommand = "touch"\nargs = ["attack-ran"]\n');
  git("add", "-A"); git("commit", "-qm", "untrusted");
  const target = join(dir, "trusted.toml"); writeFileSync(target, supplied);
  return { dir, target, run: () => Bun.spawnSync(["bun", script, target, "refs/remotes/origin/main"], { cwd: dir }), text: () => readFileSync(target, "utf8") };
}

test("only main's fallback names join the supplied config", () => {
  const supplied = 'model = "review-model"\n[mcp_servers.trusted]\ncommand = "true"\n';
  const f = fixture('project_doc_fallback_filenames = ["CLAUDE.md", ".rules.md"]\n[mcp_servers.untrusted]\ncommand = "false"\n', supplied);
  expect(f.run().exitCode).toBe(0);
  expect(f.text()).toBe('project_doc_fallback_filenames = ["CLAUDE.md",".rules.md"]\n' + supplied);
  expect(Bun.TOML.parse(f.text()).mcp_servers).toEqual({ trusted: { command: "true" } });
  expect(f.run().exitCode).toBe(0); // Resumed and forked sessions use the same setup, without duplicating the key.
  expect(Bun.TOML.parse(f.text()).project_doc_fallback_filenames).toEqual(["CLAUDE.md", ".rules.md"]);
});

test.each(['[]', '["OVERRIDE.md"]'])("explicit %s wins", value => {
  const supplied = `"project_doc_fallback_filenames" = ${value}\n`;
  const f = fixture('project_doc_fallback_filenames = ["CLAUDE.md"]', supplied);
  expect(f.run().exitCode).toBe(0); expect(f.text()).toBe(supplied);
});

test.each([undefined, 'model = "other"', 'project_doc_fallback_filenames = []'])("absent or empty main settings ignore the PR's list: %s", source => {
  const f = fixture(source);
  expect(f.run().exitCode).toBe(0);
  expect(Bun.TOML.parse(f.text()).project_doc_fallback_filenames).toEqual(source?.endsWith("[]") ? [] : undefined);
});

test.each(['[', '"CLAUDE.md"', '[1]', '[""]', '[" "]', '["."]', '[".."]', '["../secret"]', '["nested/docs.md"]', '["C:\\\\secret"]', '["bad\\nname"]'])("invalid fallback data is ignored: %s", value => {
  const f = fixture(`project_doc_fallback_filenames = ${value}`);
  const result = f.run(); expect(result.exitCode).toBe(0); expect(result.stdout.toString()).toContain("::warning::");
  expect(f.text()).toBe('model = "review-model"\n');
});

test("a symlink on main is not followed", () => {
  const f = fixture("../trusted.toml", undefined, true);
  expect(f.run().exitCode).toBe(0); expect(f.text()).toBe('model = "review-model"\n');
});

test("a missing default-branch ref fails without reading the PR config", () => {
  const f = fixture('project_doc_fallback_filenames = ["CLAUDE.md"]');
  expect(Bun.spawnSync(["git", "update-ref", "-d", "refs/remotes/origin/main"], { cwd: f.dir }).exitCode).toBe(0);
  expect(f.run().exitCode).not.toBe(0); expect(f.text()).toBe('model = "review-model"\n');
});
