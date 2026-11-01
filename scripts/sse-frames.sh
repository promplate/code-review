#!/usr/bin/env bash
set -euo pipefail
cursor=$RUNNER_TEMP/sse.cursor
awk_pid=
trap '[ -z "$awk_pid" ] || { kill "$awk_pid" 2>/dev/null || true; wait "$awk_pid" 2>/dev/null || true; }' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
: > "$cursor.next"
# Some awk implementations report output errors only on exit, after running END. Publish its candidate only on success.
awk -f "$GITHUB_ACTION_PATH/scripts/sse-frames.awk" -v cursor_file="$cursor.next" -v response_file="${1:-}" <&0 &
awk_pid=$!
wait "$awk_pid"
awk_pid=
[ ! -s "$cursor.next" ] || mv "$cursor.next" "$cursor"
