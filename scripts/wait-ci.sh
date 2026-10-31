#!/usr/bin/env bash
# Usage: wait-ci.sh <sha> [<check run name regex>] [pass]. SSE wakes this wait; pass also requires successful conclusions.
set -euo pipefail
export SHA=$1 NAME=${2:-.}
checks() {
  local pages
  pages=$(gh api "repos/$GITHUB_REPOSITORY/commits/$SHA/check-runs?filter=latest&per_page=100" --paginate --slurp < /dev/null) || return
  jq -c '[.[].check_runs[] | select((.id | tostring) != (env.CHECK_ID // "") and (.id | tostring) != (env.JOB_CHECK_RUN_ID // ""))
    | select(.name != "codex-review" or .app.slug != ((env.BOT_LOGIN // "") | rtrimstr("[bot]")))
    | select(.name | test(env.NAME))]' <<< "$pages"
}
# Reading from the start covers webhooks arriving between the API request and the wait.
exec 3< <(exec tail -n +1 -F "$RUNNER_TEMP/sse.jsonl")
tail_pid=$!
trap 'exec 3<&-; kill "$tail_pid" 2>/dev/null || true; wait "$tail_pid" 2>/dev/null || true' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
deadline=$((SECONDS + ${WAIT_CI_TIMEOUT:-1800}))
while true; do
  current=$(checks) || { echo "Could not read CI checks for $SHA" >&2; exit 1; }
  if jq -e 'length > 0 and all(.status == "completed")' <<< "$current" > /dev/null; then break; fi
  # Checks that never match must fail the wait instead of hanging the review until the job timeout.
  [ "$SECONDS" -lt "$deadline" ] || { echo "No CI checks matching \"$NAME\" completed on $SHA within ${WAIT_CI_TIMEOUT:-1800}s" >&2; exit 1; }
  while true; do
    if IFS= read -r -t 30 line <&3; then
      if jq -eR 'select(startswith("data: ")) | .[6:] | fromjson? | .event as $event | .body | fromjson
        | ($event == "check_run" and .check_run.head_sha == env.SHA) or ($event == "workflow_run" and .workflow_run.head_sha == env.SHA) or ($event == "status" and .sha == env.SHA)' <<< "$line" > /dev/null; then break; fi
    else
      [ "$?" -gt 128 ] || { echo "CI event stream closed before checks completed" >&2; exit 1; }
      break
    fi
  done
done
jq -r '.[] | "\(.name): \(.conclusion)"' <<< "$current"
if [ "${3:-}" = pass ]; then
  jq -e 'all(.conclusion | IN("success", "neutral", "skipped"))' <<< "$current" > /dev/null
fi
