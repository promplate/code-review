#!/usr/bin/env bash
# Source this file to keep the selected executable and runtime in the calling shell.
[ "$AGENT" = true ] || bash "$GITHUB_ACTION_PATH/scripts/retry.sh" gh api repos/$GITHUB_REPOSITORY/check-runs/$CHECK_ID -X PATCH \
  -f "output[title]=Setting up Codex…" -f "output[summary]=Installing Codex and the review hooks." </dev/null > /dev/null
# The checkout keeps no credentials, so git fetches with the refreshed token as well; the empty helper skips credentials the runner's own helpers hold.
# Reused checkouts already have both helpers; a plain set refuses to overwrite multiple values.
git config --replace-all credential.https://github.com.helper ""
git config --add credential.https://github.com.helper "!gh auth git-credential"
# Local commits and merges need an identity too; linked worktrees share this checkout's config.
git config user.name "$BOT_LOGIN"
# gh prints HTTP error bodies to stdout, so use only the successful attempt's ID.
bash "$GITHUB_ACTION_PATH/scripts/retry.sh" bash -ec '
  bot_id=$(gh api "users/$BOT_LOGIN" --jq .id)
  git config user.email "$bot_id+$BOT_LOGIN@users.noreply.github.com"
' </dev/null
if ! command -v codex > /dev/null; then
  # A reused runner may already carry Codex; otherwise it is installed inside the job instead of the runner's global bin.
  mkdir -p "$RUNNER_TEMP/codex"
  bun add --cwd "$RUNNER_TEMP/codex" --silent "@openai/codex${CODEX_VERSION:+@$CODEX_VERSION}"
  export PATH="$RUNNER_TEMP/codex/node_modules/.bin:$PATH"
  # Actions runs later steps in fresh shells; hosted callers keep the export above.
  [ -z "${GITHUB_PATH:-}" ] || printf '%s\n' "$RUNNER_TEMP/codex/node_modules/.bin" >> "$GITHUB_PATH"
fi
CODEX_BIN=$(command -v codex)
CODEX_RUNTIME=
# Bun runs the npm launcher, but native binaries and shell wrappers execute directly.
case "$(file -Lb "$CODEX_BIN")" in *JavaScript*|*Node.js*|*node\ script*) CODEX_RUNTIME=bun ;; esac
RUNTIME_INFO="Bun $(bun --version); $($CODEX_RUNTIME "$CODEX_BIN" --version)"
export CODEX_BIN CODEX_RUNTIME RUNTIME_INFO
mkdir -p "$CODEX_HOME"
# A literal input wins over the file it replaces, so a caller can override a repository's config for one run.
[ -n "$CODEX_CONFIG" ] || [ -z "$CODEX_CONFIG_FILE" ] || CODEX_CONFIG=$(cat "$CODEX_CONFIG_FILE")
[ -n "$CODEX_CONFIG" ] || { echo "::error::Provide codex-config or codex-config-file."; exit 1; }
printf '%s\n' "$CODEX_CONFIG" > "$CODEX_HOME/config.toml"
bun "$GITHUB_ACTION_PATH/scripts/doc-fallbacks.ts" "$CODEX_HOME/config.toml" "refs/remotes/origin/$DEFAULT_BRANCH"
[ -z "$CATALOG" ] || printf '%s' "$CATALOG" > "$CODEX_HOME/models.json"
[ -n "$CODEX_AUTH" ] || [ -z "$CODEX_AUTH_FILE" ] || CODEX_AUTH=$(cat "$CODEX_AUTH_FILE")
[ -z "$CODEX_AUTH" ] || printf '%s' "$CODEX_AUTH" > "$CODEX_HOME/auth.json"
# A PostToolUse hook delivers the round's activity once its tools finish, before the model writes the next message; blocking Stop alone would only deliver it after the verdict. It must run synchronously: an async hook's context is drained after the turn and can be dropped when the session ends. The check-run label keeps its own entry so a slow PATCH cannot delay delivery.
cat >> "$CODEX_HOME/config.toml" <<EOF
[[hooks.PreToolUse]]
matcher = ".*"
[[hooks.PreToolUse.hooks]]
type = "command"
command = "bash $GITHUB_ACTION_PATH/scripts/review-hook.sh"
[[hooks.PostToolUse]]
matcher = ".*"
[[hooks.PostToolUse.hooks]]
type = "command"
command = "bash $GITHUB_ACTION_PATH/scripts/review-hook.sh"
[[hooks.Stop]]
[[hooks.Stop.hooks]]
type = "command"
command = "bash $GITHUB_ACTION_PATH/scripts/review-hook.sh"
EOF
# gh-mcp shells out to gh, so it needs the config dir whose hosts.yml the token loop keeps fresh.
# A codex-config that already names this server keeps its own definition; one that writes mcp_servers as an inline value cannot be extended by a table.
bun -e '
  const path = process.argv[1];
  let text = await Bun.file(path).text();
  // The input overrides the root setting, including quoted or indented keys, without editing multiline strings.
  if (process.env.MODEL_CATALOG) {
    const config = Bun.TOML.parse(text);
    config.model_catalog_json = `${process.env.CODEX_HOME}/models.json`;
    text = Bun.TOML.stringify(config);
    await Bun.write(path, text);
  }
  if (Bun.TOML.parse(text).mcp_servers?.gh) process.exit(0);
  // uvx resolves gh-mcp where it runs, so the job installs nothing; required keeps the first tool catalog from missing it, since optional servers only get a moment.
  // Forward the uv directories to keep downloads inside the job. Codex already forwards PATH by default.
  const config = text + "\n[mcp_servers.gh]\ncommand = \"uvx\"\nargs = [\"gh-mcp\"]\nrequired = true\nstartup_timeout_sec = 30\n" +
    "env_vars = [\"GH_CONFIG_DIR\", \"UV_CACHE_DIR\", \"UV_TOOL_DIR\", \"UV_PYTHON_INSTALL_DIR\"]\n";
  try { Bun.TOML.parse(config); }
  catch { console.log("::warning::The supplied config writes mcp_servers inline, so gh-mcp stays out of this run."); process.exit(0); }
  await Bun.write(path, config);
' "$CODEX_HOME/config.toml"
# Hosted tracing sends only metadata to the coordinator. Disable the stock
# plugin even when supplied config or a restored installation enables it: it
# uploads prompt history and tool bodies and reads repository Langfuse config.
if [ -n "${REVIEW_TRACE_RELAY_URL:-}" ]; then
  export TRACE_TO_LANGFUSE=false
  unset LANGFUSE_PUBLIC_KEY LANGFUSE_SECRET_KEY LANGFUSE_CODEX_PUBLIC_KEY LANGFUSE_CODEX_SECRET_KEY
  bun -e '
    const path = process.argv[1], config = Bun.TOML.parse(await Bun.file(path).text());
    config.plugins ??= {};
    config.plugins["tracing@codex-observability-plugin"] = { enabled: false };
    config.hooks ??= {};
    // Match the installed exporter entrypoint, not arbitrary mentions of Langfuse
    // or Codex in a checkout path, hook name, or command argument.
    const stockHook = command => {
      const entrypoint = String(command ?? "").match(/^\s*(?:bun|node)\s+("[^"]*"|\x27[^\x27]*\x27|[^\s"\x27]+)(?:\s|$)/)?.[1];
      return entrypoint !== undefined && /(?:^|\/)node_modules\/@langfuse\/codex-observability-plugin\/dist\/index\.mjs$/.test(entrypoint.replace(/^["\x27]|["\x27]$/g, ""));
    };
    for (const entries of Object.values(config.hooks)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) if (Array.isArray(entry.hooks))
        entry.hooks = entry.hooks.filter(hook => !stockHook(hook.command));
    }
    const quote = "\x27", script = process.env.GITHUB_ACTION_PATH + "/scripts/review-trace.mjs";
    const command = "bun " + quote + script.replaceAll(quote, quote + "\\" + quote + quote) + quote;
    for (const event of ["PostToolUse", "Stop"]) {
      config.hooks[event] ??= [];
      config.hooks[event].push({ ...(event === "PostToolUse" ? { matcher: ".*" } : {}), hooks: [{ type: "command", command, timeout: 10 }] });
    }
    await Bun.write(path, Bun.TOML.stringify(config));
  ' "$CODEX_HOME/config.toml"
  bun "$GITHUB_ACTION_PATH/scripts/review-trace.mjs" --init
# Existing non-hosted callers retain their explicitly configured tracing.
elif [ -n "${LANGFUSE_PUBLIC_KEY:-}" ] || [ -f ~/.codex/langfuse.json ]; then
  mkdir -p "$RUNNER_TEMP/langfuse"
  bun add --cwd "$RUNNER_TEMP/langfuse" --silent @langfuse/codex-observability-plugin
  printf '[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "bun %s/langfuse/node_modules/@langfuse/codex-observability-plugin/dist/index.mjs"\ntimeout = 30\n' "$RUNNER_TEMP" >> "$CODEX_HOME/config.toml"
  # The plugin is disabled by default and keys do not enable it; only the job's own keys are ours to switch on.
  [ -z "$LANGFUSE_PUBLIC_KEY" ] || export TRACE_TO_LANGFUSE=true
fi
