#!/usr/bin/env bash
set -euo pipefail
awk_pid=
trap '[ -z "$awk_pid" ] || { kill "$awk_pid" 2>/dev/null || true; wait "$awk_pid" 2>/dev/null || true; }' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
awk -f "$GITHUB_ACTION_PATH/scripts/sse-frames.awk" -v response_file="${1:-}" -v reconnect_file="${2:-}" <&0 &
awk_pid=$!
wait "$awk_pid"
awk_pid=
