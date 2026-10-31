#!/usr/bin/env bash
input=$(cat)
if jq -e '.hook_event_name == "PreToolUse"' <<< "$input" > /dev/null; then
  # Four backticks keep fences inside commands and patches from closing the block early.
  jq -c '{Bash: "sh", apply_patch: "diff"}[.tool_name] as $lang
    | {output: {title: "Reviewing…", summary: (if $lang then "````\($lang)\n\(.tool_input.command[0:3000])\n````" else "`\(.tool_name)`\n\n````json\n\(.tool_input | tojson | .[0:3000])\n````" end)}}' <<< "$input" \
    | bash "$GITHUB_ACTION_PATH/scripts/retry.sh" gh api "repos/$GITHUB_REPOSITORY/check-runs/$CHECK_ID" -X PATCH --input - > /dev/null || true
  exit 0
fi

# PreToolUse additionalContext lands between parallel tool calls and their outputs, which strict providers reject, so deliver activity by blocking Stop.
jq -e '.hook_event_name == "Stop"' <<< "$input" > /dev/null || exit 0
[ -f "$RUNNER_TEMP/sse.jsonl" ] || exit 0
SEEN_FILE="$RUNNER_TEMP/injected-deliveries.json"
seen='[]'
[ ! -f "$SEEN_FILE" ] || seen=$(cat "$SEEN_FILE")
# Anyone can comment on public repositories, so only comments and reviews from people with write access steer the review.
result=$(jq -Rrs --arg pr "$PR_NUMBER" --argjson seen "$seen" '
  [split("\n")[] | select(startswith("data: ")) | .[6:] | fromjson? // empty
    | . as $frame | ($frame.body | fromjson) as $body
    | select(
        ($frame.event == "check_run" and $body.action == "completed" and $body.check_run.head_sha == env.HEAD_SHA
          and $body.check_run.name != "codex-review" and ($body.check_run.id | tostring) != (env.JOB_CHECK_RUN_ID // "") and ($body.check_run.id | tostring) != (env.CHECK_ID // ""))
        or ($frame.event == "workflow_run" and $body.action == "completed" and $body.workflow_run.head_sha == env.HEAD_SHA and ($body.workflow_run.id | tostring) != (env.GITHUB_RUN_ID // ""))
        or ($frame.event == "status" and $body.sha == env.HEAD_SHA and ($body.state | IN("success", "failure", "error")))
        or ($frame.event == "push" and $body.ref == ("refs/heads/" + env.HEAD_BRANCH) and $body.after != env.HEAD_SHA)
        or (if $pr == "" then $frame.event == "commit_comment" and $body.comment.commit_id == env.HEAD_SHA
          else ($frame.event | IN("pull_request", "issue_comment", "pull_request_review", "pull_request_review_comment", "pull_request_review_thread"))
            and (($frame.event != "pull_request") or ($body.action | IN("opened", "synchronize", "reopened", "ready_for_review") | not))
            and ([$body.number, $body.issue.number, $body.pull_request.number] | map(select(. != null)) | first == ($pr | tonumber)) end))
    | select($body.sender.login != env.BOT_LOGIN)
    | select(($frame.event | IN("commit_comment", "issue_comment", "pull_request_review", "pull_request_review_comment", "pull_request_review_thread") | not)
        or ($frame.writer == true and $body.sender.type != "Bot"))
    | select(($frame.event | IN("check_run", "status") | not) or (env.GITHUB_RUN_ID // "") == ""
        or (($body.check_run.details_url // $body.target_url // "") | test("/actions/runs/" + env.GITHUB_RUN_ID + "(/|[?#]|$)") | not))
    | {delivery: $frame.delivery, context: ({event: $frame.event, action: $body.action, actor: $body.sender.login,
        url: ($body.comment.html_url // $body.review.html_url // $body.check_run.details_url // $body.workflow_run.html_url // $body.target_url),
        head: ($body.after // $body.check_run.head_sha // $body.workflow_run.head_sha // $body.sha), commit: $body.comment.commit_id,
        name: ($body.check_run.name // $body.workflow_run.name // $body.context), conclusion: ($body.check_run.conclusion // $body.workflow_run.conclusion), state: $body.state,
        merged: (if $body.action == "closed" then $body.pull_request.merged else null end), comment: $body.comment.body, path: ($body.comment.path // $body.thread.comments[0].path), line: ($body.comment.line // $body.thread.comments[0].line),
        review: ($body.review | if . == null then null else {state, body} end), resolved: $body.thread.resolved} | with_entries(select(.value != null)))}
  ] | reduce .[] as $event ({seen: $seen, context: []}; if (.seen | index($event.delivery)) then . else .seen += [$event.delivery] | .context += [$event.context | tojson] end)
    | .context |= join("\n")
' "$RUNNER_TEMP/sse.jsonl")
jq -c .seen <<< "$result" > "$SEEN_FILE"
context=$(jq -r .context <<< "$result")
[ -n "$context" ] || exit 0
subject=${PR_NUMBER:+PR #$PR_NUMBER}
jq -n --arg subject "${subject:-branch $HEAD_BRANCH}" --arg context "$context" '{decision: "block", reason: ("New GitHub activity on " + $subject + ":\n" + $context + "\nTake it into account, reply with regular comments where useful, and output the full updated JSON review.")}'
