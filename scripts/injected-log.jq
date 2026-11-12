# Formats the GitHub activity the Stop hook injects into the review, which `codex exec --json` never carries.
# Colours follow meaning, not event names: red, yellow and green are CI outcomes, cyan is something a person wrote,
# blue is the branch or pull request moving, and magenta is the broker warning that history is incomplete.
def ci_color: (.conclusion // .state // "")
  | if . == "success" then 92
    elif IN("failure", "error", "timed_out", "cancelled", "startup_failure", "action_required") then 91
    else 93 end;
def event_color:
  if .event == "replay_gap" then 95
  elif (.event | IN("issue_comment", "pull_request_review", "pull_request_review_comment", "pull_request_review_thread", "commit_comment")) then 96
  elif (.event | IN("push", "pull_request")) then 94
  elif (.event | IN("check_run", "workflow_run", "status")) then ci_color
  else 97 end;
def event_line: "\u001b[\(event_color)m\(.event)\(if .action then "/" + .action else "" end)\u001b[0m"
  + (if .actor then " " + .actor else "" end) + (if .name then " " + .name else "" end)
  + (if .conclusion then ":" + .conclusion else "" end) + (if .state then ":" + .state else "" end)
  + (if .url then " " + .url else "" end);
# Event text comes from GitHub payloads, and the runner parses a workflow command in any line of stdout: `::` after leading whitespace, and legacy `##[` anywhere.
# Break every marker, including overlapping colons: concurrent tool output can insert a newline inside a long event record.
# A zero-width space keeps the log readable without sharing the tool logger's suppression token.
def escape_commands: gsub("\r"; "") | gsub("##\\["; "#​#[") | gsub(":(?=:)"; ":​");
(fromjson? // null) as $event
| (if $event == null then . else ($event | event_line) end)
| escape_commands
# The live log view paints a band behind lines that carry only whitespace, and copied logs keep it; emit no trailing spaces.
| gsub("(?m)[ \t]+$"; "") | rtrimstr("\n") + "\n"
