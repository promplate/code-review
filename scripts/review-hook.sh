#!/usr/bin/env bash
input=$(cat)
event=$(jq -r '.hook_event_name // ""' <<< "$input") || exit 0
case $event in
  PreToolUse)
    # A check run shows the command under review while it runs; delivery has its own hook so a slow PATCH cannot delay it.
    if [ -n "${CHECK_ID:-}" ]; then
      # Four backticks keep fences inside commands and patches from closing the block early.
      jq -c '{Bash: "sh", apply_patch: "diff"}[.tool_name] as $lang
        | {output: {title: "Reviewing…", summary: (if $lang then "````\($lang)\n\(.tool_input.command[0:3000])\n````" else "`\(.tool_name)`\n\n````json\n\(.tool_input | tojson | .[0:3000])\n````" end)}}' <<< "$input" \
        | bash "$GITHUB_ACTION_PATH/scripts/retry.sh" gh api "repos/$GITHUB_REPOSITORY/check-runs/$CHECK_ID" -X PATCH --input - > /dev/null || true
    fi
    exit 0 ;;
  PostToolUse)
    # A subagent's context never reaches the review, so only the root agent consumes shared activity.
    [ -z "$(jq -r '.agent_id // empty' <<< "$input")" ] || exit 0 ;;
  Stop) ;;
  *) exit 0 ;;
esac
[ -f "$RUNNER_TEMP/sse.jsonl" ] || exit 0
# An unchanged stream carries nothing new; Stop always scans so a skipped or failed delivery still reaches the review.
size=$(wc -c < "$RUNNER_TEMP/sse.jsonl")
[ "$event" = Stop ] || [ "$size" != "$(cat "$RUNNER_TEMP/injected.size" 2>/dev/null)" ] || exit 0
# The delivery process owns both the lock and all output/receipt writes.
exec "$GITHUB_ACTION_PATH/scripts/review-bun.sh" "$GITHUB_ACTION_PATH/scripts/review-hook.mjs" "$event" "$size"
