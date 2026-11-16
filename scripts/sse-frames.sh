#!/usr/bin/env bash
set -euo pipefail
awk_pid=
trap '[ -z "$awk_pid" ] || { kill "$awk_pid" 2>/dev/null || true; wait "$awk_pid" 2>/dev/null || true; }' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# mawk otherwise buffers its input until a block fills, delaying live events even though output is flushed.
awk_options=()
case "$(awk -W version </dev/null 2>&1)" in mawk*) awk_options=(-W interactive) ;; esac
awk ${awk_options[@]+"${awk_options[@]}"} -f "$GITHUB_ACTION_PATH/scripts/sse-frames.awk" -v response_file="${1:-}" -v reconnect_file="${2:-}" <&0 &
awk_pid=$!
wait "$awk_pid"
awk_pid=
