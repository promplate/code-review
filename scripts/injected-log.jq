# Formats the GitHub activity the Stop hook injects into the review, which `codex exec --json` never carries.
# One bright colour per kind of event, so a reader can skim what arrived between turns.
def event_color: {"push": 92, "pull_request": 91, "issue_comment": 96, "pull_request_review": 95, "pull_request_review_comment": 96, "pull_request_review_thread": 94, "check_run": 93, "workflow_run": 93, "status": 93, "commit_comment": 94, "replay_gap": 91}[.event] // 97;
def event_line: "\u001b[\(event_color)m\(.event)\(if .action then "/" + .action else "" end)\u001b[0m"
  + (if .actor then " " + .actor else "" end) + (if .name then " " + .name else "" end)
  + (if .conclusion then ":" + .conclusion else "" end) + (if .state then ":" + .state else "" end)
  + (if .url then " " + .url else "" end);
# Event text comes from GitHub payloads, and the runner parses a workflow command in any line of stdout: `::` after leading space, and legacy `##[` anywhere.
# A zero-width space inside the marker keeps the parser from matching it while the log reads the same; a suppression token would have to be shared with the tool log, which writes to this log at the same time.
def escape_commands: gsub("\r"; "") | gsub("##\\["; "#​#[") | gsub("(?m)^(?<indent> *)::"; "​\(.indent)::");
(fromjson? // null) as $event
| (if $event == null then . else ($event | event_line) end)
| escape_commands
# The live log view paints a band behind lines that carry only whitespace, and copied logs keep it; emit no trailing spaces.
| gsub("(?m)[ \t]+$"; "") | rtrimstr("\n") + "\n"
