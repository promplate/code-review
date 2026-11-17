#!/usr/bin/env bash
set -eo pipefail
# A hosted queue owns subsequent heads. Pin the submitted review to this head even if a push races the API request.
if [ "$REVIEW_HOSTED" = true ]; then
  current=$(bash "$GITHUB_ACTION_PATH/scripts/retry.sh" gh api "repos/$GITHUB_REPOSITORY/pulls/$PR_NUMBER" --jq .head.sha </dev/null)
  if [ "$current" != "$HEAD_SHA" ]; then printf '%s\n' "$current" > "$RUNNER_TEMP/superseded"; exit 0; fi
fi
# The review state carries the verdict; its body is optional for approvals. GitHub rejects APPROVE and REQUEST_CHANGES on the App's own PRs.
REVIEWS=$(bash "$GITHUB_ACTION_PATH/scripts/retry.sh" gh api "repos/$GITHUB_REPOSITORY/pulls/$PR_NUMBER/reviews?per_page=100" </dev/null)
# The last verdict as a whole, so the state it stands in and the head it judged cannot disagree.
VERDICT=$(jq -c '[.[] | select(.user.login == env.BOT_LOGIN and .state != "COMMENTED")] | last // {}' <<< "$REVIEWS")
LAST=$(jq -r '.state // ""' <<< "$VERDICT")
# On the App's own PRs, publish only a nonempty COMMENT review and use its body to avoid repeats.
LAST_COMMENT=$(jq -r '[.[] | select(.user.login == env.BOT_LOGIN and .state == "COMMENTED")] | last | .body // ""' <<< "$REVIEWS")
# A comment rarely changes the verdict, and repeating a change request would duplicate its threads.
# Review comments must sit inside diff hunks, so must-fix issues elsewhere go into the body as permalinks, which GitHub renders as snippets.
HUNKS=$(bash "$GITHUB_ACTION_PATH/scripts/retry.sh" gh api "repos/$GITHUB_REPOSITORY/pulls/$PR_NUMBER/files?per_page=100" --paginate \
  --jq '.[] | {(.filename): [.patch // "" | scan("@@ -\\d+(?:,\\d+)? \\+(\\d+)(?:,(\\d+))? @@") | (.[0] | tonumber) as $start | [$start, $start + (.[1] // "1" | tonumber)]]}' </dev/null | jq -cs add)
# A finding an earlier review posted and nobody resolved is already on the pull request; posting it again would open a second thread for one root cause.
# GraphQL bot logins omit the [bot] suffix used by REST.
THREADS=$(bash "$GITHUB_ACTION_PATH/scripts/retry.sh" bash "$GITHUB_ACTION_PATH/scripts/review-threads.sh" list </dev/null \
  | jq -c --arg bot "$BOT_LOGIN" '[.[] | select(.isResolved == false and .firstComment.author == ($bot | rtrimstr("[bot]"))) | {path, line, body: .firstComment.body}]')
jq -n --argjson review "$(cat "$RUNNER_TEMP/review.json")" --argjson hunks "$HUNKS" --argjson threads "$THREADS" \
  --arg blob "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/blob/$(git rev-parse HEAD)" \
  --argjson verdict "$VERDICT" --arg author "$PR_AUTHOR" --arg last "$LAST" --arg lastComment "$LAST_COMMENT" '
  def in_diff: .line as $line | any($hunks[.path][]?; .[0] <= $line and $line < .[1]);
  # The same wording on the same path is the same finding; a thread GitHub marked outdated keeps only its path and body to compare.
  def reported: . as $issue | any($threads[]; .path == $issue.path and .body == $issue.message and (.line == null or .line == $issue.line));
  if $review.conclusion == "failure" and $last == "CHANGES_REQUESTED"
     and (env.GITHUB_EVENT_NAME | IN("issue_comment", "pull_request_review", "pull_request_review_comment", "pull_request_review_thread", "repository_dispatch")) then empty
  elif $review.conclusion == "failure" then [$review.annotations[] | select(.level == "failure") | select(reported | not)] as $issues
    | ([$issues[] | select(in_diff)] | length) as $inline
    | ([$review.summary, ($issues[] | select(in_diff | not) | "\(.message)\n\($blob)/\(.path)#L\(.line)")] | join("\n\n")) as $body
    # Silence only repeats: a new inline finding still publishes even when the body matches, and a human pull request keeps the standing change request only when there is one.
    | if ($inline == 0 and ($issues | length) == 0 and ($review.summary | test("\\S") | not))
         and ($author == env.BOT_LOGIN or $last == "CHANGES_REQUESTED") then empty
      # Two runs can review one head; a standing change request with nothing new to say is not worth restating.
      elif $last == "CHANGES_REQUESTED" and $inline == 0 and ($issues | length) == 0 and $verdict.commit_id == env.HEAD_SHA then empty
      elif $inline == 0 and $lastComment != "" and $body == $lastComment then empty
      else {
    event: (if $author == env.BOT_LOGIN then "COMMENT" else "REQUEST_CHANGES" end),
    # Restoring a change request still needs a body when every finding already has a thread.
    body: (if ($issues | length) == 0 and ($body | test("\\S") | not) then
      [$review.annotations[] | select(.level == "failure") | .message] | join("\n\n") else $body end),
    comments: [$issues[] | select(in_diff) | {path, line, side: "RIGHT", body: .message}]} end
  elif $author == env.BOT_LOGIN then
    if ($review.summary | test("\\S") | not) or $lastComment == $review.summary then empty else {event: "COMMENT", body: $review.summary} end
  elif $last == "APPROVED" then empty
  else {event: "APPROVE"} + (if $review.summary | test("\\S") then {body: $review.summary} else {} end) end' > "$RUNNER_TEMP/pr-review.json"
if [ "$REVIEW_HOSTED" = true ] && [ -s "$RUNNER_TEMP/pr-review.json" ]; then
  jq --arg sha "$HEAD_SHA" '. + {commit_id: $sha}' "$RUNNER_TEMP/pr-review.json" > "$RUNNER_TEMP/pr-review-pinned.json"
  mv "$RUNNER_TEMP/pr-review-pinned.json" "$RUNNER_TEMP/pr-review.json"
fi
[ ! -s "$RUNNER_TEMP/pr-review.json" ] || bash "$GITHUB_ACTION_PATH/scripts/retry.sh" gh api repos/$GITHUB_REPOSITORY/pulls/$PR_NUMBER/reviews --input "$RUNNER_TEMP/pr-review.json" </dev/null
