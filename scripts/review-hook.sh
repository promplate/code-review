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
    | select(.event as $event | ["pull_request", "issue_comment", "pull_request_review", "pull_request_review_comment", "pull_request_review_thread"] | index($event))
    | . as $frame | ($frame.body | fromjson) as $body
    | select([$body.number, $body.issue.number, $body.pull_request.number] | map(select(. != null)) | first == ($pr | tonumber))
    | select(($seen | index($frame.delivery)) | not)
    | select($body.sender.login != env.BOT_LOGIN)
    | select(($body.comment // $body.review) == null or $frame.writer)
    | {delivery: $frame.delivery, context: ({event: $frame.event, action: $body.action, actor: $body.sender.login, url: ($body.comment.html_url // $body.review.html_url),
        head: $body.after, merged: (if $body.action == "closed" then $body.pull_request.merged else null end), comment: $body.comment.body, path: ($body.comment.path // $body.thread.comments[0].path), line: ($body.comment.line // $body.thread.comments[0].line),
        review: ($body.review | if . == null then null else {state, body} end), resolved: $body.thread.resolved} | with_entries(select(.value != null)))}
  ] as $new | {seen: ($seen + [$new[].delivery]), context: ($new | map(.context | tojson) | join("\n"))}
' "$RUNNER_TEMP/sse.jsonl")
jq -c .seen <<< "$result" > "$SEEN_FILE"
context=$(jq -r .context <<< "$result")
[ -n "$context" ] || exit 0
jq -n --arg pr "$PR_NUMBER" --arg context "$context" '{decision: "block", reason: ("New GitHub activity on PR #" + $pr + ":\n" + $context + "\nTake it into account, reply with regular PR comments where useful, and output the full updated JSON review.")}'
