#!/usr/bin/env bash
set -o pipefail
# Metadata is display-only: look it up here, never in the hook that delivers activity to the review.
# The worker owns its tail so the end marker drains every delivered event before both processes exit.
exec 3< <(tail -n +1 -f "$1" 2>/dev/null)
tail_pid=$!
cleanup() { kill "$tail_pid" 2>/dev/null || true; wait "$tail_pid" 2>/dev/null || true; }
trap cleanup EXIT
trap 'exit 0' TERM INT
declare -A workflows
while IFS= read -r line <&3; do
  request=$(jq -er '
    if .review_log_end == true then "end"
    else select(.event == "check_run" and .app.slug == "github-actions" and ((.workflow // "") == ""))
      | select(.check_suite_id | type == "number" and . > 0 and . <= 9007199254740991 and floor == .)
      | select(.head | type == "string" and test("^[a-fA-F0-9]{40}$"))
      | [.check_suite_id, .head] | @tsv end
  ' <<< "$line" 2>/dev/null) || request=
  [ "$request" != end ] || break
  if [ -n "$request" ]; then
    IFS=$'\t' read -r suite head <<< "$request"
    key="$suite:$head"
    if [ -z "${workflows[$key]+set}" ] && [ ! -f "$RUNNER_TEMP/injected.done" ]; then
      # Cache misses too: a matrix must not repeat a denied or timed-out lookup for every job.
      workflows[$key]=
      workflow=$(GH_TOKEN="${REVIEW_ACTIONS_TOKEN:-${GH_TOKEN:-}}" timeout --kill-after=1s 4s gh api \
        "repos/$GITHUB_REPOSITORY/actions/runs?check_suite_id=$suite&per_page=1" </dev/null 2>/dev/null \
        | jq -er --argjson suite "$suite" --arg head "$head" '
          [.workflow_runs[]? | select(.check_suite_id == $suite and .head_sha == $head) | .name | strings | select(length > 0)]
          | if length == 1 then .[0] else empty end
        ' 2>/dev/null) || workflow=
      workflows[$key]=$workflow
    fi
    if [ -n "${workflows[$key]:-}" ]; then
      enriched=$(jq -c --arg workflow "${workflows[$key]}" '. + {workflow: $workflow}' <<< "$line" 2>/dev/null) && line=$enriched
    fi
  fi
  printf '%s\n' "$line" | jq --unbuffered -rR -f "$GITHUB_ACTION_PATH/scripts/injected-log.jq"
done
