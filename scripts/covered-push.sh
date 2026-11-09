#!/usr/bin/env bash
# Usage: covered-push.sh <base> <head>
# Prints "<verdict> <reviewed head>" when a merged pull request already reviewed the tree this push lands, and exits 1 otherwise.
set -euo pipefail
base=$1 head=$2
[ -n "$base" ] || exit 1
git cat-file -e "$base^{commit}" 2>/dev/null || exit 1
# A rewind lands older, unreviewed state; only a head extending the base can repeat a tree this session reviewed.
git merge-base --is-ancestor "$base" "$head" 2>/dev/null || exit 1
api() { gh api "repos/${GITHUB_REPOSITORY:?}/$1" 2>/dev/null; }
# The tip alone decides: a review covers the state it left behind, so a matching tree means the push brings nothing new.
tree=$(git rev-parse "$head^{tree}")
# Only a merged PR vouches for its head; the API also lists unmerged ones whose branch happens to share a commit.
while read -r number prhead; do
  [ -n "$number" ] || continue
  prtree=$(api "git/commits/$prhead" | jq -r .tree.sha) || continue
  [ "$tree" = "$prtree" ] || continue
  # A check run another app happens to name the same is not a verdict; the slug keeps this to our own reviews.
  # A run that died before judging leaves a neutral check, which is not a verdict either.
  conclusion=$(api "commits/$prhead/check-runs?check_name=code-review&per_page=100" \
    | jq -r --arg bot "${BOT_LOGIN:-}" '[.check_runs[] | select(.status == "completed" and (.conclusion == "success" or .conclusion == "failure") and .app.slug == ($bot | rtrimstr("[bot]")))] | last | .conclusion // empty') || conclusion=
  [ -n "$conclusion" ] || continue
  printf '%s %s\n' "$conclusion" "$prhead"
  exit 0
done < <(api "commits/$head/pulls?per_page=100" | jq -r '.[] | select(.merged_at != null) | "\(.number) \(.head.sha)"' || true)
exit 1
