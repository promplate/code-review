# Turns `codex exec --json` output into a readable log: shell commands folded with their output, other tool names, and Codex's messages.
# Exec reports shell commands as `<shell> -c <script>` or `-lc`, with the script quoted as a single shell word.
def script: sub("^\\S+ -l?c "; "") | if startswith("'") then .[1:-1] elif startswith("\"") then .[1:-1] | gsub("\\\\(?<c>[\\s\\S])"; .c) else . end;
# Tool output is dimmed, so what the reviewer said stands out from what its commands printed.
def dim: "\u001b[2m\(.)\u001b[0m";
fromjson? // {type: "error", message: .}
| if .type == "error" then .message
  elif .type == "turn.failed" then .error.message
  elif .type == "item.completed" and (.item.type | IN("agent_message", "error")) then .item.text // .item.message
  # Parallel commands overlap, so each is printed once it finishes, titled by its first line; only output a reporter could parse as a workflow command needs stop-commands around it.
  elif .type == "item.completed" and .item.type == "command_execution" then
    (.item.aggregated_output | gsub("\r"; "") | rtrimstr("\n") | gsub("(?m)[ \t]+$"; "")) as $out
    | ("::group::$ \(.item.command | script)"
      + (if $out | test("(?m)^ *::") then "\n::stop-commands::\($stop)\n" + ($out | dim) + "\n::\($stop)::"
         elif $out == "" then "" else "\n" + ($out | dim) end)
      + "\n::endgroup::")
  elif .type == "item.started" and (.item.type | IN("agent_message", "reasoning", "command_execution") | not) then .item.tool // .item.type
  else empty end
# The live log view paints a band behind lines that carry only whitespace, and copied logs keep it; emit no trailing spaces.
| gsub("\r"; "") | gsub("(?m)[ \t]+$"; "") | rtrimstr("\n") + "\n"
