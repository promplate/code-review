#!/usr/bin/env bash
set -euo pipefail

retry() { bash "$GITHUB_ACTION_PATH/scripts/retry.sh" gh api "$@" </dev/null; }
endpoint="repos/$GITHUB_REPOSITORY/actions/artifacts"
# An exact-name query works across refs and keeps unrelated workflow artifacts out of the lookup.
key=$(printf '%s\0%s' "$MODEL_NAME" "$1" | sha256sum | cut -d ' ' -f1)
name=agent-session-$key
lookup() {
  local artifacts
  artifacts=$(
    for slot in "$1" "$1-next"; do
      retry "$endpoint" --paginate --method GET -f "name=$slot" -f per_page=100 || exit 1
    done
  ) || return 1
  jq -cs '[
    .[].artifacts[] | select(.expired == false and (.workflow_run.head_repository_id | tostring) == env.GITHUB_REPOSITORY_ID)
  ] | sort_by(.created_at, .id)' <<< "$artifacts"
}
# A listing failure must fail the step: every later step reads the snapshot this one reports.
snapshots=$(lookup "$name") || exit 1
# Sessions saved before the rename still hold running conversations; the next save moves them to the new name.
if [ "$snapshots" = "[]" ]; then snapshots=$(lookup "code-review-session-$key") || exit 1; fi
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
if [ -n "${REPLACE_SNAPSHOT_ID:-}" ]; then
  if [ -z "$id" ] || jq -e --argjson failed "$REPLACE_SNAPSHOT_ID" 'any(.[]; .id == $failed)' <<< "$snapshots" >/dev/null; then
    echo "::error::The fork session download failed and the selected snapshot was not replaced." >&2
    exit 1
  fi
fi
# Reruns share a workflow run ID. Use the other name if overwriting would remove the latest snapshot.
if [ "$run" = "$GITHUB_RUN_ID" ] && [ "$slot" = "$name" ]; then name=$name-next; fi
printf 'id=%s\nrun-id=%s\nname=%s\n' "$id" "$run" "$name" >> "$GITHUB_OUTPUT"
