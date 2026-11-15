// Only the default branch may choose instruction filenames; the reviewed checkout still supplies their contents, just as it supplies AGENTS.md.
const path = process.argv[2], ref = process.argv[3];
const text = await Bun.file(path).text(), config = Bun.TOML.parse(text);
if (Object.hasOwn(config, "project_doc_fallback_filenames")) process.exit(0);
const git = (...args: string[]) => {
  const result = Bun.spawnSync(["git", ...args]);
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString();
};
git("rev-parse", "--verify", `${ref}^{commit}`);
const entry = git("ls-tree", ref, "--", ".codex/config.toml");
// A symlink must not redirect this read into the reviewed tree or the runner's files.
if (!/^100(644|755) blob /.test(entry)) process.exit(0);
let fallback: unknown;
try { fallback = Bun.TOML.parse(git("show", `${ref}:.codex/config.toml`)).project_doc_fallback_filenames; }
catch { console.log("::warning::Ignoring invalid default-branch .codex/config.toml."); process.exit(0); }
if (fallback === undefined) process.exit(0);
if (!Array.isArray(fallback) || !fallback.every(name => typeof name === "string" && name.trim().length > 0 && name !== "." && name !== ".." && !/[\\/:\x00-\x1f\x7f]/.test(name))) {
  console.log("::warning::Ignoring project_doc_fallback_filenames: expected an array of filenames."); process.exit(0);
}
// Prepend a root key without reserializing unrelated settings or placing it under the last TOML table.
await Bun.write(path, `project_doc_fallback_filenames = ${JSON.stringify(fallback)}\n${text}`);
