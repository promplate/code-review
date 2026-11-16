#!/usr/bin/env bash
set -eo pipefail
# Persist consumption only after every required publication succeeds, so a retry can replay failed delivery.
mkdir -p "$CODEX_HOME/sessions"
jq -Rsc 'split("\n") - [""] | reduce .[] as $id ([]; if index($id) then . else . + [$id] end) | .[-200:]' "$RUNNER_TEMP/injected-deliveries.log" > "$CODEX_HOME/sessions/.github-deliveries.json"
# A successor still needs its own annotated review even if this run published an intermediate commit verdict.
rm -f "$CODEX_HOME/sessions/.github-published-head"
[ "$SUPERSEDED" = true ] || printf '%s\n' "$HEAD_SHA" > "$CODEX_HOME/sessions/.github-published-head"
