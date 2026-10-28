# Turns `codex exec --json` output into a readable log: shell commands, other tool names, and Codex's messages.
fromjson? // {type: "error", message: .}
| if .type == "error" then .message
  elif .type == "turn.failed" then .error.message
  elif .type == "item.completed" and (.item.type | IN("agent_message", "error")) then .item.text // .item.message
  # Exec reports shell commands as `<shell> -lc <script>`, with the script quoted as a single shell word.
  elif .type == "item.started" and .item.type == "command_execution" then
    .item.command | sub("^\\S+ -lc "; "") | "$ " + if startswith("'") then .[1:-1] elif startswith("\"") then .[1:-1] | gsub("\\\\(?<c>[\\s\\S])"; .c) else . end
  elif .type == "item.started" and (.item.type | IN("agent_message", "reasoning") | not) then .item.tool // .item.type
  else empty end
