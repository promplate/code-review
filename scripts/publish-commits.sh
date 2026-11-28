#!/usr/bin/env bash
set -eo pipefail
jq -c --arg head "$HEAD_SHA" '.commits[] | select(.sha != $head)' "$RUNNER_TEMP/review.json" | while read -r verdict; do
  sha=$(jq -r .sha <<< "$verdict")
  conclusion=$(jq -r .conclusion <<< "$verdict")
  id=$(jq -rs --arg sha "$sha" 'map(select(.sha == $sha)) | last | .id // empty' "$CODEX_HOME/check-runs.jsonl")
  # The newer review covers reviewed heads and commits with their own runs, but not commits CI pushed during this one.
  if [ "$SUPERSEDED" = true ]; then [ -z "$id" ] && [ "$(GH_TOKEN=$REVIEW_ACTIONS_TOKEN bash "$GITHUB_ACTION_PATH/scripts/retry.sh" --idempotent gh api "repos/$GITHUB_REPOSITORY/actions/runs?head_sha=$sha" \
    --jq 'any(.workflow_runs[]; .name == env.GITHUB_WORKFLOW)' </dev/null)" != true ] || continue; fi
  # A superseded review may have already posted verdicts for commits CI pushed during it.
  if [ -z "$id" ]; then
    count=$(bash "$GITHUB_ACTION_PATH/scripts/retry.sh" --idempotent gh api "repos/$GITHUB_REPOSITORY/commits/$sha/check-runs?check_name=code-review" --jq .total_count </dev/null) || exit 1
    [ "$count" = 0 ] || continue
  fi
  # Commits CI pushed during the review have no check run yet.
  jq -n --arg sha "$sha" --arg conclusion "$conclusion" --arg summary "$(jq -L "$GITHUB_ACTION_PATH/scripts" -r --arg conclusion "$conclusion" 'include "summary"; summary_line($conclusion)' "$RUNNER_TEMP/review.json")" '{name: "code-review", head_sha: $sha, status: "completed", conclusion: $conclusion, output: {
    title: (if $conclusion == "failure" then "Blocking defect introduced here" else "Innocent commit" end), summary: $summary}}' \
    | if [ -n "$id" ]; then jq 'del(.head_sha)' | bash "$GITHUB_ACTION_PATH/scripts/retry.sh" --idempotent gh api repos/$GITHUB_REPOSITORY/check-runs/$id -X PATCH --input -
      else bash "$GITHUB_ACTION_PATH/scripts/retry.sh" gh api repos/$GITHUB_REPOSITORY/check-runs --input - > /dev/null; fi
done
