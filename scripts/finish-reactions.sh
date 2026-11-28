#!/usr/bin/env bash
set -eo pipefail
# Replace only this bot's reactions; earlier verdicts must not leave contradictory signals behind.
bash "$GITHUB_ACTION_PATH/scripts/retry.sh" --idempotent gh api "repos/$GITHUB_REPOSITORY/issues/$PR_NUMBER/reactions?per_page=100" --paginate </dev/null \
  | jq -r --slurpfile review "$RUNNER_TEMP/review.json" '.[] | select(.user.login == env.BOT_LOGIN) | select(.content as $content | $review[0].reactions | index($content) | not) | .id' \
  | while read -r id; do bash "$GITHUB_ACTION_PATH/scripts/retry.sh" --idempotent-delete gh api repos/$GITHUB_REPOSITORY/issues/$PR_NUMBER/reactions/$id -X DELETE </dev/null; done
# A comment's eyes is not part of the verdict reactions replaced below.
[ -z "$EYES_REACTION_ID" ] || bash "$GITHUB_ACTION_PATH/scripts/retry.sh" --idempotent-delete gh api "repos/$GITHUB_REPOSITORY/$EYES_REACTION_PATH" -X DELETE </dev/null
if [ -n "${GITHUB_ENV:-}" ]; then printf "EYES_REACTION_PATH=\nEYES_REACTION_ID=\n" >> "$GITHUB_ENV"; fi
jq -r '.reactions | unique[]' "$RUNNER_TEMP/review.json" | while read -r reaction; do
  bash "$GITHUB_ACTION_PATH/scripts/retry.sh" --idempotent gh api repos/$GITHUB_REPOSITORY/issues/$PR_NUMBER/reactions -f content="$reaction" </dev/null
done
