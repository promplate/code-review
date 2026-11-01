#!/usr/bin/env bash
# Usage: wait-ci.sh <sha> [<check run name regex>] [pass]. SSE wakes this wait; pass also requires successful conclusions.
set -euo pipefail
export SHA=$1 NAME=${2:-.}
# Other runs of this workflow are review status, not CI: one queued behind this job can never start, so waiting for it would deadlock.
# The App token has no Actions access, so the Merge step hands over the job token for these two lookups.
WORKFLOW_ID=
[ -z "${ACTIONS_TOKEN:-}" ] || WORKFLOW_ID=$(GH_TOKEN=$ACTIONS_TOKEN gh api "repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID" --paginate < /dev/null | jq -r .workflow_id) || WORKFLOW_ID=
checks() {
  # Recomputed every poll: a run queued while this one waits must be excluded too.
  own='[]'
  [ -z "$WORKFLOW_ID" ] || own=$(GH_TOKEN=$ACTIONS_TOKEN gh api "repos/$GITHUB_REPOSITORY/actions/runs?head_sha=$SHA&per_page=100" --paginate < /dev/null | jq -sc "[.[].workflow_runs[] | select(.workflow_id == $WORKFLOW_ID) | .check_suite_id]") || own='[]'
  export OWN_CHECK_SUITES=$own
  gh api "repos/$GITHUB_REPOSITORY/commits/$SHA/check-runs?filter=latest&per_page=100" --paginate < /dev/null | jq -s -c '[.[].check_runs[] | select((.id | tostring) != (env.CHECK_ID // "") and (.id | tostring) != (env.JOB_CHECK_RUN_ID // ""))
    | select(.check_suite.id as $suite | (env.OWN_CHECK_SUITES | fromjson | index($suite)) | not)
    | select(.app.slug != ((env.BOT_LOGIN // "") | rtrimstr("[bot]")))
    | select(.name | test(env.NAME))]'
}
# Reading from the start covers webhooks arriving between the API request and the wait.
exec 3< <(exec tail -n +1 -F "$RUNNER_TEMP/sse.jsonl")
tail_pid=$!
trap 'exec 3<&-; kill "$tail_pid" 2>/dev/null || true; wait "$tail_pid" 2>/dev/null || true' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
deadline=$((SECONDS + ${WAIT_CI_TIMEOUT:-1800}))
expired() { echo "No CI checks matching \"$NAME\" completed on $SHA within ${WAIT_CI_TIMEOUT:-1800}s" >&2; exit 1; }
while true; do
  current=$(checks) || { echo "Could not read CI checks for $SHA" >&2; exit 1; }
  # An empty list usually means the checks have not appeared yet, except for callers that may proceed without any.
  if jq -e '(length > 0 or env.WAIT_CI_ALLOW_EMPTY == "1") and all(.status == "completed")' <<< "$current" > /dev/null; then break; fi
  recheck=$((SECONDS + ${WAIT_CI_RECHECK:-30}))
  while true; do
    # Heartbeats cannot postpone either the deadline or the API fallback for a missed webhook.
    [ "$SECONDS" -lt "$deadline" ] || expired
    [ "$SECONDS" -lt "$recheck" ] || break
    remaining=$(((deadline < recheck ? deadline : recheck) - SECONDS))
    [ "$remaining" -gt 0 ] || continue
    if IFS= read -r -t "$remaining" line <&3; then
      # Most frames are for other commits, and jq per line costs more than the match that rejects them.
      [[ "$line" == *"$SHA"* ]] || continue
      if jq -eR 'select(startswith("data: ")) | .[6:] | fromjson? | .event as $event | .body | fromjson
        | ($event == "check_run" and .check_run.head_sha == env.SHA) or ($event == "workflow_run" and .workflow_run.head_sha == env.SHA) or ($event == "status" and .sha == env.SHA)' <<< "$line" > /dev/null; then break; fi
    else
      status=$?
      [ "$SECONDS" -lt "$deadline" ] || expired
      [ "$SECONDS" -lt "$recheck" ] || break
      [ "$status" -gt 128 ] || { echo "CI event stream closed before checks completed" >&2; exit 1; }
      break
    fi
  done
done
jq -r '.[] | "\(.name): \(.conclusion)"' <<< "$current"
if [ "${3:-}" = pass ]; then
  jq -e 'all(.conclusion | IN("success", "neutral", "skipped"))' <<< "$current" > /dev/null
fi
