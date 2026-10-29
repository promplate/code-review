# Turns `codex exec --json` output into a readable log: shell commands folded with their output, other tool names, and Codex's messages.
# Exec reports shell commands as `<shell> -c <script>` or `-lc`, with the script quoted as a single shell word.
def script: sub("^\\S+ -l?c "; "") | if startswith("'") then .[1:-1] elif startswith("\"") then .[1:-1] | gsub("\\\\(?<c>[\\s\\S])"; .c) else . end;
fromjson? // {type: "error", message: .}
| if .type == "error" then .message
  elif .type == "turn.failed" then .error.message
  elif .type == "item.completed" and (.item.type | IN("agent_message", "error")) then .item.text // .item.message
  # Parallel commands overlap, so each is printed once it finishes, titled by its first line; stop-commands keeps output such as test reporters' `::error` lines from becoming annotations.
  elif .type == "item.completed" and .item.type == "command_execution" then
    ("::group::$ \(.item.command | script)\n" | sub("\n"; "\n::stop-commands::\($stop)\n")) + (.item.aggregated_output | rtrimstr("\n")) + "\n::\($stop)::\n::endgroup::"
  elif .type == "item.started" and (.item.type | IN("agent_message", "reasoning", "command_execution") | not) then .item.tool // .item.type
  else empty end
# GitHub's live log view drops empty lines, so blank lines between and within entries hold a single space.
| " \n" + gsub("\n(?=\n)"; "\n ")
