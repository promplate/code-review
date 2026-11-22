# Formats the GitHub activity the Stop hook injects into the review, which `codex exec --json` never carries.
# Colours follow meaning, not event names: green passed, red failed, yellow finished without a verdict (skipped,
# neutral, cancelled), cyan is something a person wrote, blue is the branch or pull request moving, and magenta is
# an interrupted subscription requesting reconciliation.
def verdict: if .event == "check_run" then .check_run.conclusion elif .event == "workflow_run" then .workflow_run.conclusion elif .event == "status" then .state else null end;
def ci_color: (verdict // "")
  | if . == "success" then 92
    elif IN("failure", "error", "timed_out", "action_required", "startup_failure") then 91
    else 93 end;
def event_color:
  if .event == "subscription_recovery" then 95
  elif (.event | IN("issue_comment", "pull_request_review", "pull_request_review_comment", "pull_request_review_thread", "commit_comment")) then 96
  elif (.event | IN("push", "pull_request")) then 94
  elif (.event | IN("check_run", "workflow_run", "status")) then ci_color
  else 97 end;
# The hook has the received head SHA even when GitHub supplied no activity URL.
def moved: if .event == "push" then .after else .pull_request.head.sha end;
def target_url: (.comment.html_url // .review.html_url // .thread.comments[0].html_url // .check_run.details_url // .workflow_run.html_url // .target_url)
  // (if (.event == "push" or (.event == "pull_request" and .action == "synchronize"))
      and ((moved // "") | test("^(?!0{40}$)[a-fA-F0-9]{40}$"))
    then (env.PR_NUMBER // "") as $pr | (if $pr == "" then "/commit/" else "/pull/\($pr)/commits/" end) + moved
    else null end);
# A CI webhook sender is the triggering actor, not the workflow or the app providing its checks.
# `workflow` is correlated display metadata; the remaining fields retain the webhook's names and nesting.
def nonempty: strings | select(length > 0);
def event_subject:
  if .event == "check_run" then [((.workflow | nonempty) // (.check_run.app.name | nonempty) // (.check_run.app.slug | nonempty)), .check_run.name] | map(nonempty) | join(" / ")
  elif .event == "workflow_run" then (.workflow_run.name // "")
  elif .event == "status" then (.context // "")
  elif .event == "subscription_recovery" then ""
  else (.sender.login // "") end;
def event_line: "\u001b[\(event_color)m\(.event)\(if .action then "/" + .action else "" end)\u001b[0m"
  + (event_subject | if . == "" then "" else " " + . end)
  + (verdict | if . then ":" + . else "" end)
  + (target_url | if . then " " + . else "" end);
# Event text comes from GitHub payloads, and the runner parses a workflow command in any line of stdout: `::` after leading whitespace, and legacy `##[` anywhere.
# Break every marker, including overlapping colons: concurrent tool output can insert a newline inside a long event record.
# A zero-width space keeps the log readable without sharing the tool logger's suppression token.
def escape_commands: gsub("\r"; "") | gsub("##\\["; "#​#[") | gsub(":(?=:)"; ":​");
(fromjson? // null) as $event
| (if $event == null then . else ($event | event_line) end)
| escape_commands
# The live log view paints a band behind lines that carry only whitespace, and copied logs keep it; emit no trailing spaces.
| gsub("(?m)[ \t]+$"; "") | rtrimstr("\n") + "\n"
