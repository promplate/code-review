#!/usr/bin/env bash
# Call only after the coordinator has durably saved CODEX_HOME for this successful publication.
set -eo pipefail
: "${GITHUB_ACTION_PATH:?Path to the pinned code-review source}"
: "${CODEX_HOME:?Published session directory}"
: "${GH_CONFIG_DIR:?Repository-scoped GitHub credentials}"
pending="$CODEX_HOME/sessions/.github-pending-drafts"
[ -s "$pending" ] || exit 0
left=$(mktemp)
trap 'rm -f "$left"' EXIT
while IFS= read -r url; do
  [ -n "$url" ] || continue
  case "$url" in "https://github.com/$GITHUB_REPOSITORY/pull/"*) ;; *) echo 'Pending PR belongs to another repository' >&2; exit 1 ;; esac
  draft=$(bash "$GITHUB_ACTION_PATH/scripts/retry.sh" gh pr view "$url" --json state,isDraft --jq '.state == "OPEN" and .isDraft' </dev/null) || { printf '%s\n' "$url" >> "$left"; continue; }
  [ "$draft" = true ] || continue
  bash "$GITHUB_ACTION_PATH/scripts/retry.sh" gh pr ready "$url" </dev/null || printf '%s\n' "$url" >> "$left"
done < "$pending"
if [ -s "$left" ]; then mv "$left" "$pending"; else rm -f "$pending"; fi
