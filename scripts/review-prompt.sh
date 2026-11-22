#!/usr/bin/env bash
# Stable review policy changes independently of the HEAD, event and checkout context.
review_prompt_version() {
  { cat "$GITHUB_ACTION_PATH/scripts/instructions.sh" "$GITHUB_ACTION_PATH/scripts/run-review.sh"
    printf '%s\0' "$AGENT" "$MODE_INSTRUCTIONS" "$EXTRA_INSTRUCTIONS"
  } | sha256sum | cut -d ' ' -f1
}

# An unknown rollout format must re-inject rules rather than assume they survived.
review_prompt_compactions() {
  local rollout count status=0
  [ -d "$CODEX_HOME/sessions" ] || { printf 'unknown\n'; return; }
  rollout=$(find "$CODEX_HOME/sessions" -type f -name "rollout-*-$1.jsonl" -print -quit) || { printf 'unknown\n'; return; }
  [ -n "$rollout" ] || { printf 'unknown\n'; return; }
  count=$(grep -Ec '"type"[[:space:]]*:[[:space:]]*"compacted"' "$rollout") || status=$?
  if [ "$status" -gt 1 ]; then printf 'unknown\n'; else printf '%s\n' "$count"; fi
}

review_prompt_needs_rules() {
  local previous_thread previous_version previous_compactions
  [ "$3" != unknown ] || return 0
  [ -f "$CODEX_HOME/sessions/.review-prompt-state" ] || return 0
  read -r previous_thread previous_version previous_compactions < "$CODEX_HOME/sessions/.review-prompt-state" || return 0
  [ "$previous_thread" != "$1" ] || [ "$previous_version" != "$2" ] || [ "$previous_compactions" != "$3" ]
}

review_prompt_record() {
  local state="$CODEX_HOME/sessions/.review-prompt-state"
  mkdir -p "$CODEX_HOME/sessions"
  printf '%s %s %s\n' "$1" "$2" "$3" > "$state.$$"
  mv -f "$state.$$" "$state"
}
