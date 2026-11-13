#!/usr/bin/env bash
set -euo pipefail

retry() { bash "$GITHUB_ACTION_PATH/scripts/retry.sh" gh api "$@" </dev/null; }
endpoint="repos/$GITHUB_REPOSITORY/actions/artifacts"
# An exact-name query works across refs and keeps unrelated workflow artifacts out of the lookup.
name=code-review-session-$(printf '%s\0%s' "$MODEL_NAME" "$1" | sha256sum | cut -d ' ' -f1)
artifacts=$(
  for slot in "$name" "$name-next"; do
    retry "$endpoint" --paginate --method GET -f "name=$slot" -f per_page=100 || exit 1
  done
)
snapshots=$(jq -cs '[
  .[].artifacts[] | select(.expired == false and (.workflow_run.head_repository_id | tostring) == env.GITHUB_REPOSITORY_ID)
] | sort_by(.created_at, .id)' <<< "$artifacts")
if [ -n "${2:-}" ]; then
  # The successor must be visible to the same lookup used for restore before either slot is pruned.
  jq -r --argjson saved "$2" '
    map(.id) | index($saved) as $index |
    if $index == null then error("New session snapshot is not listed") else .[:$index][] end
  ' <<< "$snapshots" | while read -r id; do retry "$endpoint/$id" -X DELETE > /dev/null; done
  exit 0
fi

latest=$(jq -r 'last | [.id, .workflow_run.id, .name] | @tsv' <<< "$snapshots")
read -r id run slot <<< "$latest"
# Reruns share a workflow run ID. Use the other name if overwriting would remove the latest snapshot.
if [ "$run" = "$GITHUB_RUN_ID" ] && [ "$slot" = "$name" ]; then name=$name-next; fi
printf 'id=%s\nrun-id=%s\nname=%s\n' "$id" "$run" "$name" >> "$GITHUB_OUTPUT"
