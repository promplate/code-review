#!/usr/bin/env bash
# Usage: wait-ci.sh <sha> [<check run name regex>]. Returns once the matching check runs on the commit complete; check_run webhooks relayed over SSE wake it up instead of polling.
export SHA=$1 NAME=${2:-.}
pending() {
  bash "$GITHUB_ACTION_PATH/scripts/retry.sh" gh api "repos/$GITHUB_REPOSITORY/commits/$SHA/check-runs?filter=latest&per_page=100" \
    --jq '[.check_runs[] | select(.name != "codex-review" and .status != "completed" and (.name | test(env.NAME)))] | length' < /dev/null
}
# Reading the relay log from its start means no webhook slips through between a check and the wait.
exec 3< <(exec tail -n +1 -F "$RUNNER_TEMP/sse.jsonl")
while [ "$(pending)" != 0 ]; do
  until read -r line <&3 && [[ $line == *'"check_run"'* && $line == *"$SHA"* ]]; do :; done
done
kill $!
gh api "repos/$GITHUB_REPOSITORY/commits/$SHA/check-runs?filter=latest&per_page=100" --jq '.check_runs[] | select(.name != "codex-review" and (.name | test(env.NAME))) | "\(.name): \(.conclusion)"'
