#!/usr/bin/env bash
set -euo pipefail
cursor=$RUNNER_TEMP/sse.cursor
: > "$cursor.next"
# Some awk implementations report output errors only on exit, after running END. Publish its candidate only on success.
awk -f "$GITHUB_ACTION_PATH/scripts/sse-frames.awk" -v cursor_file="$cursor.next"
[ ! -s "$cursor.next" ] || mv "$cursor.next" "$cursor"
