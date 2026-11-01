#!/usr/bin/env bash
set -euo pipefail
cursor=${1:-}
curl_pid= parser_pid= sleep_pid= warned= pipe_dir= retry_delay=1
cleanup() {
  status=$?
  trap - EXIT
  for pid in "$curl_pid" "$parser_pid" "$sleep_pid"; do
    [ -z "$pid" ] || { kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; }
  done
  [ -z "$pipe_dir" ] || { rm -f "$pipe_dir/stream" "$pipe_dir/response"; rmdir "$pipe_dir"; }
  if [ "$status" != 0 ] && [ "$status" != 130 ] && [ "$status" != 143 ]; then
    printf 'The GitHub event subscription stopped with status %s.\n' "$status" > "$RUNNER_TEMP/sse.failed"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
rm -f "$RUNNER_TEMP/sse.failed"
pipe_dir=$(mktemp -d "$RUNNER_TEMP/sse.XXXXXX")
mkfifo "$pipe_dir/stream"
while true; do
  : > "$pipe_dir/response"
  # Separate children let cancellation interrupt wait and reap the entire subscription, including the frame parser.
  bash "$GITHUB_ACTION_PATH/scripts/sse-frames.sh" "$pipe_dir/response" < "$pipe_dir/stream" >> "$RUNNER_TEMP/sse.jsonl" &
  parser_pid=$!
  curl -ifsSN --suppress-connect-headers --max-time 60 ${cursor:+-H "Last-Event-ID: $cursor"} "$EVENTS_URL&pr=${PR_NUMBER:-}&sha=$HEAD_SHA&run=$GITHUB_RUN_ID" > "$pipe_dir/stream" 2>>"$RUNNER_TEMP/sse.err" &
  curl_pid=$!
  curl_status=0; wait "$curl_pid" || curl_status=$?; curl_pid=
  parser_status=0; wait "$parser_pid" || parser_status=$?; parser_pid=
  [ "$parser_status" = 0 ] || exit "$parser_status"
  if [ "$curl_status" = 0 ] || [ "$curl_status" = 28 ]; then
    response=$(cat "$pipe_dir/response")
    if [ "$response" != '200 text/event-stream' ]; then
      printf 'Expected HTTP 200 text/event-stream, received %s (curl %s).\n' "${response:-no response}" "$curl_status" >> "$RUNNER_TEMP/sse.err"
      curl_status=invalid_response
    fi
  fi
  [ ! -s "$RUNNER_TEMP/sse.cursor" ] || cursor=$(cat "$RUNNER_TEMP/sse.cursor")
  delay=1
  # curl 28 is the normal connection rotation; only HTTP/network errors back off, with jitter to spread concurrent jobs.
  if [ "$curl_status" != 0 ] && [ "$curl_status" != 28 ]; then
    jitter=$((retry_delay / 4)); delay=$((retry_delay - jitter + RANDOM % (jitter + 1)))
    retry_delay=$((retry_delay * 2)); [ "$retry_delay" -le 30 ] || retry_delay=30
    if [ "$warned" != "$cursor:failed" ]; then
      jq -nr --arg delivery "gap:connection:$cursor" --arg status "$curl_status" \
        '"event: replay_gap\ndata: \(({event: "replay_gap", delivery: $delivery, writer: false, body: ({reason: "connection_failed", status: $status} | tojson)} | tojson))\n"' >> "$RUNNER_TEMP/sse.jsonl"
      warned=$cursor:failed
    fi
  else warned=; retry_delay=1; fi
  sleep "$delay" & sleep_pid=$!
  wait "$sleep_pid"; sleep_pid=
done
