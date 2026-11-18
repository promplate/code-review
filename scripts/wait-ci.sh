#!/usr/bin/env bash
# Usage: wait-ci.sh <sha> [<check run name regex>] [pass]. SSE wakes this wait; pass also requires successful conclusions.
set -euo pipefail
export SHA=$1 NAME=${2:-.}
# Other runs of this workflow are review status, not CI: one queued behind this job can never start, so waiting for it would deadlock.
# Use the same gh authentication as the check lookup, including the App credentials in GH_CONFIG_DIR.
WORKFLOW_ID= WORKFLOW_PATH=
if [ "${REVIEW_HOSTED:-}" = true ] || [[ ! "${GITHUB_RUN_ID:-}" =~ ^[0-9]+$ ]]; then
  # A hosted attempt has a UUID, not an Actions run. Prefer its exact caller path;
  # display names are not identities: absent/invalid refs retain every check.
  if [ -n "${GITHUB_WORKFLOW_REF:-}" ]; then
    if [[ $GITHUB_WORKFLOW_REF =~ ^"$GITHUB_REPOSITORY"/(\.github/workflows/[^/]+\.ya?ml)@(.+)$ ]] && git check-ref-format "refs/${BASH_REMATCH[2]}"; then
      WORKFLOW_PATH=${BASH_REMATCH[1]}
    fi
  fi
else
  WORKFLOW_ID=$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID" --paginate < /dev/null | jq -er '.workflow_id | select(type == "number")') || WORKFLOW_ID=
fi
[ -n "$WORKFLOW_ID$WORKFLOW_PATH" ] || echo "::notice::Waiting for every check: this workflow's other runs are not readable."
checks() {
  # Recomputed every poll: a run queued while this one waits must be excluded too.
  own='[]'
  if [ -n "$WORKFLOW_ID$WORKFLOW_PATH" ]; then
    own=$(gh api "repos/$GITHUB_REPOSITORY/actions/runs?head_sha=$SHA&per_page=100" --paginate < /dev/null |
      jq -sc --arg self "${GITHUB_RUN_ID:-}" --arg workflow "$WORKFLOW_ID" --arg path "$WORKFLOW_PATH" '
        [.[].workflow_runs[] | select(
          if $workflow != "" then (.workflow_id | tostring) == $workflow and (.id | tostring) != $self
          else .path == $path end
        ) | .check_suite_id | select(. != null)]') || own='[]'
  fi
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
dead=
expired() { echo "No CI checks matching \"$NAME\" completed on $SHA within ${WAIT_CI_TIMEOUT:-1800}s" >&2; exit 1; }
while true; do
  current=$(checks) || { echo "Could not read CI checks for $SHA" >&2; exit 1; }
  # An empty list usually means the checks have not appeared yet, except for callers that may proceed without any.
  if jq -e '(length > 0 or env.WAIT_CI_ALLOW_EMPTY == "1") and all(.status == "completed")' <<< "$current" > /dev/null; then break; fi
  while true; do
    # Heartbeats cannot postpone the deadline; the API is read again only when a frame says events may have been missed.
    [ "$SECONDS" -lt "$deadline" ] || expired
    # A subscription that reported its own end will send nothing more, so the API is re-read before the deadline runs out.
    window=$((deadline - SECONDS))
    if [ -n "$dead" ]; then
      window=$((window / 2 < 30 ? window / 2 : 30))
      [ "$window" -gt 0 ] || window=1
    fi
    if IFS= read -r -t "$window" line <&3; then
      [[ "$line" != *subscription_failed* ]] || dead=1
      # The subscription reports every interruption, so a recovery frame is the signal to re-read instead of polling.
      [[ "$line" != *subscription_recovery* ]] || break
      # Most frames are for other commits, and jq per line costs more than the match that rejects them.
      [[ "$line" == *"$SHA"* ]] || continue
      if jq -eR 'select(startswith("data: ")) | .[6:] | fromjson? | .event as $event | .body | fromjson
        | ($event == "check_run" and .check_run.head_sha == env.SHA) or ($event == "workflow_run" and .workflow_run.head_sha == env.SHA) or ($event == "status" and .sha == env.SHA)' <<< "$line" > /dev/null; then break; fi
    else
      status=$?
      [ "$SECONDS" -lt "$deadline" ] || expired
      if [ "$status" -le 128 ]; then
        [ -n "$dead" ] || { echo "CI event stream closed before checks completed" >&2; exit 1; }
        # EOF is immediate on every read, so a closed tail needs the delay the read would otherwise supply.
        sleep "$window"
      fi
      break
    fi
  done
done
jq -r '.[] | "\(.name): \(.conclusion)"' <<< "$current"
if [ "${3:-}" = pass ]; then
  jq -e 'all(.conclusion | IN("success", "neutral", "skipped"))' <<< "$current" > /dev/null
fi
