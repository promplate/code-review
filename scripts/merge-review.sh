#!/usr/bin/env bash
set -eo pipefail
merge=$(jq -c 'select(.conclusion == "success") | .merge // empty' "$RUNNER_TEMP/review.json")
[ -n "$merge" ] || exit 0
# The verdict already weighed CI and ran what it judged necessary, so a check still running or flaky is not a gate here.
# A push (such as a formatter) or a person can move the branch or close the PR while the review runs; merging then would land code no review saw, or fail on a closed PR.
read -r state head < <(bash "$GITHUB_ACTION_PATH/scripts/retry.sh" --idempotent gh api "repos/$GITHUB_REPOSITORY/pulls/$PR_NUMBER" --jq '.state + " " + .head.sha' </dev/null)
[ "$state" = open ] || { echo "::notice::Not merging: the pull request is $state."; exit 0; }
[ "$head" = "$HEAD_SHA" ] || { echo "::notice::Not merging: the branch moved past $HEAD_SHA to $head."; exit 0; }
bash "$GITHUB_ACTION_PATH/scripts/retry.sh" gh pr merge "$PR_NUMBER" --$(jq -r .method <<< "$merge") --subject "$(jq -r .subject <<< "$merge")" --body "$(jq -r .body <<< "$merge")" --match-head-commit "$HEAD_SHA" </dev/null
