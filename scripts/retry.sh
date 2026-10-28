#!/usr/bin/env bash
# Preserve stdin so retries can replay --input - payloads.
input=$(cat)
delay=1
for attempt in 1 2 3 4 5; do
  if printf '%s' "$input" | "$@"; then exit 0; fi
  sleep "$delay"
  delay=$((delay * 2))
done
exit 1
