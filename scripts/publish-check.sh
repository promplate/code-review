#!/usr/bin/env bash
set -eo pipefail
PUSHED=$(jq -Rrs '[split("\n")[] | select(startswith("data: ")) | .[6:] | fromjson? // empty | .event as $event | .body | fromjson
  | select(if env.PR_NUMBER then $event == "pull_request" and .number == (env.PR_NUMBER | tonumber) and .action == "synchronize" and .after != null else $event == "push" and .ref == env.GITHUB_REF end)
  | .after] | .[]' < "$RUNNER_TEMP/sse.jsonl")
# Pushes made with GITHUB_TOKEN, such as CI autofixes, start no workflow, so this review covers them instead of leaving them to a newer run.
# The branch may move after the last Stop hook, before the SSE writer catches up.
if [ -n "$PR_NUMBER" ]; then
  current=$(bash "$GITHUB_ACTION_PATH/scripts/retry.sh" gh api "repos/$GITHUB_REPOSITORY/pulls/$PR_NUMBER" --jq .head.sha </dev/null) || {
    echo "::warning::Could not refresh PR #$PR_NUMBER before publication."; current=
    [ "${REVIEW_HOSTED:-}" != true ] || exit 1
  }
  [ -z "$current" ] || PUSHED="$PUSHED $current"
fi
# Hosted scheduling owns the next head, including force pushes that have no ancestry relation.
if [ "$REVIEW_HOSTED" = true ]; then
  [ -z "$current" ] || [ "$current" = "$HEAD_SHA" ] || NEWER=$current
else
# CI may push before this run subscribes, so whether a run exists tells them apart, not the push sender.
for sha in $(git rev-parse HEAD) $PUSHED; do
  if [ "$sha" = "$HEAD_SHA" ]; then continue; fi
  [ "$(GH_TOKEN=$REVIEW_ACTIONS_TOKEN bash "$GITHUB_ACTION_PATH/scripts/retry.sh" gh api "repos/$GITHUB_REPOSITORY/actions/runs?head_sha=$sha" \
    --jq 'any(.workflow_runs[]; .name == env.GITHUB_WORKFLOW)' </dev/null)" = true ] || continue
  # A seeded trigger can name an older push; only a commit ahead of HEAD supersedes this review.
  # The comparison needs Contents access, which the App token already has.
  if [ "$(bash "$GITHUB_ACTION_PATH/scripts/retry.sh" gh api "repos/$GITHUB_REPOSITORY/compare/$HEAD_SHA...$sha" \
    --jq .status </dev/null)" = ahead ]; then NEWER=$sha; fi
done
fi
if [ -z "$NEWER" ] && [ -n "$current" ] && ! jq -e --arg sha "$current" 'any(.commits[]; .sha == $sha)' "$RUNNER_TEMP/review.json" > /dev/null; then
  echo "::warning::PR #$PR_NUMBER moved to $current after this review. A subsequent review run is needed for that head."
fi
if [ -n "$NEWER" ]; then
  [ -z "${GITHUB_ENV:-}" ] || echo "SUPERSEDED=true" >> "$GITHUB_ENV"
  printf '%s\n' "$NEWER" > "$RUNNER_TEMP/superseded"
  # A check left in progress would wait forever on a commit nothing will finish reviewing.
  # Neutral, not cancelled: GitHub counts a cancelled check as a failing one in the merge box, and this commit simply has a successor.
  jq -n --arg newer "$NEWER" '{status: "completed", conclusion: "neutral", output: {
    title: ("Superseded by " + $newer[0:7] + " — review continues there"),
    summary: "A newer commit was pushed during this review, so no verdict is posted for this commit."}}' \
    | bash "$GITHUB_ACTION_PATH/scripts/retry.sh" gh api repos/$GITHUB_REPOSITORY/check-runs/$CHECK_ID -X PATCH --input -
  # The run that continues on the newer commit keeps its own reaction; this one is done waiting.
  [ -z "$EYES_REACTION_ID" ] || bash "$GITHUB_ACTION_PATH/scripts/retry.sh" gh api "repos/$GITHUB_REPOSITORY/$EYES_REACTION_PATH" -X DELETE </dev/null
  exit 0
fi
jq -n -L "$GITHUB_ACTION_PATH/scripts" --arg sha "$HEAD_SHA" --argjson review "$(cat "$RUNNER_TEMP/review.json")" '
include "summary";
($review.commits[] | select(.sha == $sha)) as $commit | {
name: "code-review", head_sha: $sha, status: "completed",
conclusion: $commit.conclusion,
output: {
  title: (if $commit.conclusion == "failure" then "Blocking defect introduced here" else "Innocent commit" end),
  summary: ($review | summary_line($commit.conclusion)),
  annotations: [$review.annotations[:50][] | {path, start_line: .line, end_line: .line, annotation_level: .level, message}]
}}' | bash "$GITHUB_ACTION_PATH/scripts/retry.sh" gh api repos/$GITHUB_REPOSITORY/check-runs/$CHECK_ID -X PATCH --input -
