# Turns `codex exec --json` output into a readable log: shell commands folded with their output, other tool names, and Codex's messages.
# Exec reports shell commands as `<shell> -c <script>` or `-lc`, with the script quoted as a single shell word.
def script: sub("^\\S+ -l?c "; "") | if startswith("'") then .[1:-1] elif startswith("\"") then .[1:-1] | gsub("\\\\(?<c>[\\s\\S])"; .c) else . end;
# Tool output is greyed, so what the reviewer said stands out from what its commands printed.
# The viewer ignores the faint attribute, so this uses bright black; it styles each line on its own, so every line carries its own escape.
def dim: split("\n") | map("\u001b[90m\(.)\u001b[0m") | join("\n");
# JSON reads best with the colouring jq gives it in a terminal: keys, strings, numbers and literals each get a colour.
def json: def hstr: tojson | "\u001b[32m\(.)\u001b[0m";
  def hkey: tojson | "\u001b[36m\(.)\u001b[0m";
  if type == "object" then "{" + (to_entries | map("\(.key | hkey):\(.value | json)") | join(",")) + "}"
  elif type == "array" then "[" + (map(json) | join(",")) + "]"
  elif type == "string" then hstr
  elif type == "number" then "\u001b[33m\(tostring)\u001b[0m"
  elif type == "boolean" then "\u001b[35m\(tostring)\u001b[0m"
  else "\u001b[90mnull\u001b[0m" end;
# A result that is JSON gets the same colouring; anything else stays grey.
def body_render: (try fromjson catch null) as $j | if $j == null then dim else $j | json end;
# Item titles are data too; break command markers there and suppress commands while printing their bodies.
def fold($title; $body):
  ($body | gsub("\r"; "")) as $out
  | "::group::\($title | gsub("\r"; "") | gsub("##\\["; "#​#[") | gsub(":(?=:)"; ":​"))"
    + (if $out == "" then ""
       elif $out | test("##\\[|::") then "\n::stop-commands::\($stop)\n" + $out + "\n::\($stop)::"
       else "\n" + $out end)
    + "\n::endgroup::";
# The settled verdict is one JSON record, marked by its conclusion so it does not read as more prose.
def verdict: (. | fromjson? // null) as $v | if ($v | type) == "object" and $v.conclusion then "\u001b[1;\(if $v.conclusion == "failure" then 31 else 32 end)m\(if $v.conclusion == "failure" then "✗" else "✓" end)\u001b[0m \($v | json)" else . end;
fromjson? // {type: "error", message: .}
| if .type == "error" then .message
  elif .type == "turn.failed" then .error.message
  elif .type == "item.completed" and .item.type == "agent_message" then (.item.text // "" | verdict)
  elif .type == "item.completed" and .item.type == "error" then .item.text // .item.message
  # Parallel commands overlap, so each is printed once it finishes, titled by its first line; only output a reporter could parse as a workflow command needs stop-commands around it.
  # The runner also reads legacy `##[` commands anywhere in a line, so text that carries either form gets wrapped.
  elif .type == "item.completed" and .item.type == "command_execution" then
    (.item.aggregated_output | gsub("\r"; "") | rtrimstr("\n") | gsub("(?m)[ \t]+$"; "")) as $out
    # Multiline scripts reach stdout before output suppression; break command markers as in injected activity.
    | ("::group::\u001b[90m$\u001b[0m \(.item.command | script | gsub("\r"; "") | gsub("(?m)[ \t]+$"; "") | gsub("##\\["; "#​#[") | gsub(":(?=:)"; ":​"))"
      + (if ($out | test("##\\[")) or ($out | test("(?m)^\\s*::")) then "\n::stop-commands::\($stop)\n" + ($out | dim) + "\n::\($stop)::"
         elif $out == "" then "" else "\n" + ($out | dim) end)
      + "\n::endgroup::")
  # MCP calls fold like commands do: the title names the call and its input, the block holds the result.
  elif .type == "item.completed" and .item.type == "mcp_tool_call" then
    .item as $call
    | ($call.arguments | if . == null then "" else tojson | gsub("##\\["; "#​#[") end) as $args
    | ([$call.result.content[]? | select(.type == "text") | .text] | join("\n")) as $text
    | (if $text != "" then $text elif $call.result.structured_content != null then ($call.result.structured_content | tojson) else "" end) as $body
    | ((if $args == "" or ($args | length) <= 160 then "" else "\n" + ($call.arguments | json) end)
      + (if $body == "" then "" else "\n" + ($body | gsub("\r"; "") | gsub("(?m)[ \t]+$"; "") | body_render) end)
      + (if $call.error then "\n\u001b[31m\($call.error.message | gsub("\r"; "") | gsub("(?m)[ \t]+$"; ""))\u001b[0m" else "" end)
      | gsub("\r"; "")) as $out
    | ("::group::\($call.server).\($call.tool)"
      + (if $args == "" then "" else " \u001b[36m\($args | if length > 160 then .[0:160] + "…" else . end)\u001b[0m" end)
      # Results and errors can contain workflow commands, including legacy markers after ANSI escapes.
      + (if $out | test("##\\[|::") then "\n::stop-commands::\($stop)" + $out + "\n::\($stop)::" else $out end)
      + "\n::endgroup::")
  # A file edit folds its paths; the event carries the patch status, not the diff.
  elif .type == "item.completed" and .item.type == "file_change" then
    (.item.changes // [] | map("\(.kind) \(.path)")) as $changes
    | fold("\(if .item.status == "failed" then "\u001b[31m" else "" end)edit \(if ($changes | length) > 4 then "\($changes | length) files" else ($changes | join(", ")) end)\(if .item.status == "failed" then "\u001b[0m" else "" end)";
      if ($changes | length) == 0 then "" else ($changes | join("\n") | dim) end)
  # A search folds its query and results; the other actions name their target instead.
  elif .type == "item.completed" and .item.type == "web_search" then
    .item as $search
    | (if $search.action.type == "open_page" then "open \($search.action.url // "")"
       elif $search.action.type == "find_in_page" then "find \($search.action.pattern // "") in \($search.action.url // "")"
       else "search \($search.query // "")" end) as $title
    | fold($title; if (($search.results // []) | length) == 0 then "" else ($search.results | json) end)
  # A to-do list folds as one checklist at the end of the turn.
  elif .type == "item.completed" and .item.type == "todo_list" then
    fold("todo"; if ((.item.items // []) | length) == 0 then "" else (.item.items | map("- [\(if .completed then "x" else " " end)] \(.text)") | join("\n") | dim) end)
  elif .type == "item.completed" and .item.type == "collab_tool_call" then
    fold("collab \(.item.tool)"; if .item.prompt == null then "" else (.item.prompt | gsub("\r"; "") | dim) end)
  elif .type == "item.started" and (.item.type | IN("agent_message", "reasoning", "command_execution", "mcp_tool_call", "file_change", "web_search", "todo_list", "collab_tool_call") | not) then .item.tool // .item.type
  else empty end
# The live log view paints a band behind lines that carry only whitespace, and copied logs keep it; emit no trailing spaces.
| gsub("\r"; "") | gsub("(?m)[ \t]+$"; "") | rtrimstr("\n") + "\n"
