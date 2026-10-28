#!/usr/bin/env bash
# Usage: open-pr.sh <branch> <title> <body> <path>..., run inside a worktree based on origin/$BASE with the fix applied.
set -eo pipefail
jq -n --arg ref "refs/heads/$1" --arg sha "$(git rev-parse HEAD)" '{ref: $ref, sha: $sha}' | bash "$GITHUB_ACTION_PATH/scripts/retry.sh" gh api "repos/$GITHUB_REPOSITORY/git/refs" --input - > /dev/null
HEAD_BRANCH="$1" bash "$GITHUB_ACTION_PATH/scripts/commit-fix.sh" "$2" "${@:4}"
# The PR stays a draft until this run saves its Codex session; the queued check run tells the PR's review which PR's session to fork.
bash "$GITHUB_ACTION_PATH/scripts/retry.sh" gh api "repos/$GITHUB_REPOSITORY/check-runs" -f name=codex-review -f head_sha="$(git rev-parse HEAD)" -f status=queued -f external_id="$PR_NUMBER" \
  -f "output[title]=Waiting for #$PR_NUMBER's review" -f "output[summary]=This review continues the Codex session that opened the PR." < /dev/null > /dev/null
jq -n --arg head "$1" --arg base "$BASE" --arg title "$2" --arg body "$3" '{head: $head, base: $base, title: $title, body: $body, draft: true}' \
  | bash "$GITHUB_ACTION_PATH/scripts/retry.sh" gh api "repos/$GITHUB_REPOSITORY/pulls" --input - --jq .html_url | tee -a "$RUNNER_TEMP/forked-prs"
echo "FORKED_PRS=true" >> "$GITHUB_ENV"
