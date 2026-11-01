# Turns `codex exec --json` output into a readable log: shell commands folded with their output, other tool names, and Codex's messages.
# Exec reports shell commands as `<shell> -c <script>` or `-lc`, with the script quoted as a single shell word.
def script: sub("^\\S+ -l?c "; "") | if startswith("'") then .[1:-1] elif startswith("\"") then .[1:-1] | gsub("\\\\(?<c>[\\s\\S])"; .c) else . end;
fromjson? // {type: "error", message: .}
| if .type == "error" then .message
  elif .type == "turn.failed" then .error.message
  elif .type == "item.completed" and (.item.type | IN("agent_message", "error")) then .item.text // .item.message
  # Parallel commands overlap, so each is printed once it finishes, titled by its first line; only output a reporter could parse as a workflow command needs stop-commands around it.
  elif .type == "item.completed" and .item.type == "command_execution" then
    (.item.aggregated_output | rtrimstr("\n")) as $out
    | ("::group::$ \(.item.command | script)"
      + (if $out | test("(?m)^ *::") then "\n::stop-commands::\($stop)\n" + $out + "\n::\($stop)::"
         elif $out == "" then "" else "\n" + $out end)
      + "\n::endgroup::")
  elif .type == "item.started" and (.item.type | IN("agent_message", "reasoning", "command_execution") | not) then .item.tool // .item.type
  else empty end
# The live log view hides empty lines; keep them empty rather than filling them with a space that shows up in copied logs.
| . + "\n"
