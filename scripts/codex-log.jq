# Turns `codex exec --json` output into a readable log: shell commands folded with their output, other tool names, and Codex's messages.
# Exec reports shell commands as `<shell> -c <script>` or `-lc`, with the script quoted as a single shell word.
def script: sub("^\\S+ -l?c "; "") | if startswith("'") then .[1:-1] elif startswith("\"") then .[1:-1] | gsub("\\\\(?<c>[\\s\\S])"; .c) else . end;
# Tool output is dimmed, so what the reviewer said stands out from what its commands printed.
# The log viewer styles each line on its own, so a block needs its own escape per line.
def dim: split("\n") | map("\u001b[2m\(.)\u001b[0m") | join("\n");
# The settled verdict is one JSON record, coloured by its conclusion so it does not read as more prose.
def verdict: (. | fromjson? // null) as $v | if ($v | type) == "object" and $v.conclusion then "\u001b[1;\(if $v.conclusion == "failure" then 31 else 32 end)m\(.)\u001b[0m" else . end;
fromjson? // {type: "error", message: .}
| if .type == "error" then .message
  elif .type == "turn.failed" then .error.message
  elif .type == "item.completed" and .item.type == "agent_message" then (.item.text // "" | verdict)
  elif .type == "item.completed" and .item.type == "error" then .item.text // .item.message
  # Parallel commands overlap, so each is printed once it finishes, titled by its first line; only output a reporter could parse as a workflow command needs stop-commands around it.
  # The runner also reads legacy `##[` commands anywhere in a line, so text that carries either form gets wrapped.
  elif .type == "item.completed" and .item.type == "command_execution" then
    (.item.aggregated_output | gsub("\r"; "") | rtrimstr("\n") | gsub("(?m)[ \t]+$"; "")) as $out
    | ("::group::$ \(.item.command | script)"
      + (if ($out | test("##\\[")) or ($out | test("(?m)^\\s*::")) then "\n::stop-commands::\($stop)\n" + ($out | dim) + "\n::\($stop)::"
         elif $out == "" then "" else "\n" + ($out | dim) end)
      + "\n::endgroup::")
  elif .type == "item.started" and (.item.type | IN("agent_message", "reasoning", "command_execution") | not) then .item.tool // .item.type
  else empty end
# The live log view paints a band behind lines that carry only whitespace, and copied logs keep it; emit no trailing spaces.
| gsub("\r"; "") | gsub("(?m)[ \t]+$"; "") | rtrimstr("\n") + "\n"
