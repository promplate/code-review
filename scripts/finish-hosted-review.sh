#!/usr/bin/env bash
# Call only after the coordinator has durably saved CODEX_HOME for this successful publication.
set -eo pipefail
: "${GITHUB_ACTION_PATH:?Path to the pinned code-review source}"
: "${CODEX_HOME:?Published session directory}"
: "${GH_CONFIG_DIR:?Repository-scoped GitHub credentials}"
pending="$CODEX_HOME/sessions/.github-pending-drafts"
left=$(mktemp)
trap 'rm -f "$left"' EXIT
if [ -s "$pending" ]; then
  while IFS= read -r url; do
    [ -n "$url" ] || continue
    case "$url" in "https://github.com/$GITHUB_REPOSITORY/pull/"*) ;; *) echo 'Pending PR belongs to another repository' >&2; exit 1 ;; esac
    draft=$(bash "$GITHUB_ACTION_PATH/scripts/retry.sh" gh pr view "$url" --json state,isDraft --jq '.state == "OPEN" and .isDraft' </dev/null) || { printf '%s\n' "$url" >> "$left"; continue; }
    [ "$draft" = true ] || continue
    bash "$GITHUB_ACTION_PATH/scripts/retry.sh" gh pr ready "$url" </dev/null || printf '%s\n' "$url" >> "$left"
  done < "$pending"
  if [ -s "$left" ]; then mv "$left" "$pending"; else rm -f "$pending"; fi
fi
# Merge has the same durable-session boundary as draft release. A refusal leaves the completed review intact.
if [ -f "${RUNNER_TEMP:-}/result.json" ] && jq -e '.status == "completed" and .published == true' "$RUNNER_TEMP/result.json" >/dev/null; then
  PR_AUTHOR=$(bash "$GITHUB_ACTION_PATH/scripts/retry.sh" gh api "repos/$GITHUB_REPOSITORY/pulls/$PR_NUMBER" --jq .user.login </dev/null) &&
    { [ "$PR_AUTHOR" = "$BOT_LOGIN" ] || bash "$GITHUB_ACTION_PATH/scripts/merge-review.sh"; } || echo '::warning::The review was published, but its merge could not be completed.'
fi
