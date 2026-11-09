#!/usr/bin/env bash
# Usage: covered-push.sh <base> <head>
# Succeeds when every commit in base..head was already reviewed as a pull request head with the same tree.
set -euo pipefail
base=$1 head=$2
[ -n "$base" ] || exit 1
git cat-file -e "$base^{commit}" 2>/dev/null || exit 1
api() { gh api "repos/${GITHUB_REPOSITORY:?}/$1" 2>/dev/null; }
for sha in $(git rev-list "$base..$head"); do
  # The tree is the content a review covers, so a commit whose tree matches a reviewed PR head brings nothing new.
  tree=$(git rev-parse "$sha^{tree}")
  covered=
  # Only a merged PR vouches for its head; the API also lists unmerged ones whose branch happens to match.
  while read -r number prhead; do
    [ -n "$number" ] || continue
    prtree=$(api "git/commits/$prhead" | jq -r .tree.sha) || continue
    [ "$tree" = "$prtree" ] || continue
    # A check run another app happens to name the same is not a verdict; the slug keeps this to our own reviews.
    reviewed=$(api "commits/$prhead/check-runs?check_name=code-review" \
      | jq -r --arg bot "${BOT_LOGIN:-}" '[.check_runs[] | select(.status == "completed" and .app.slug == ($bot | rtrimstr("[bot]")))] | length') || reviewed=0
    [ "${reviewed:-0}" != 0 ] && { covered=$prhead; break; }
  done < <(api "commits/$sha/pulls" | jq -r '.[] | select(.merged_at != null) | "\(.number) \(.head.sha)"' || true)
  [ -n "$covered" ] || exit 1
done
exit 0
