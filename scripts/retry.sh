#!/usr/bin/env bash
# Preserve stdin so retries can replay --input - payloads.
input=$(cat)
err=$(mktemp)
delay=1
for attempt in 1 2 3 4 5 6 7 8; do
  if printf '%s' "$input" | "$@" 2> "$err"; then cat "$err" >&2; exit 0; fi
  cat "$err" >&2
  # A DELETE whose response was lost has already taken effect, so the retry's 404 means it is done.
  [[ " $* " != *" -X DELETE "* ]] || ! grep -q 'HTTP 404' "$err" || exit 0
  [ "$attempt" = 8 ] || sleep "$delay"
  delay=$((delay * 2 > 30 ? 30 : delay * 2))
done
exit 1
