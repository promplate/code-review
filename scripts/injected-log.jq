# Formats the GitHub activity the Stop hook injects into the review, which `codex exec --json` never carries.
# One bright colour per kind of event, so a reader can skim what arrived between turns.
def event_color: {"push": 92, "pull_request": 91, "issue_comment": 96, "pull_request_review": 95, "pull_request_review_comment": 96, "pull_request_review_thread": 94, "check_run": 93, "workflow_run": 93, "status": 93, "commit_comment": 94, "replay_gap": 91}[.event] // 97;
def event_line: "\u001b[\(event_color)m\(.event)\(if .action then "/" + .action else "" end)\u001b[0m"
  + (if .actor then " " + .actor else "" end) + (if .name then " " + .name else "" end)
  + (if .conclusion then ":" + .conclusion else "" end) + (if .state then ":" + .state else "" end)
  + (if .url then " " + .url else "" end);
(fromjson? // null) as $event | if $event == null then . else ($event | event_line) end
