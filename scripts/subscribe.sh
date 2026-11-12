#!/usr/bin/env bash
set -euo pipefail
curl_pid= parser_pid= sleep_pid= warned= pipe_dir= retry_delay=1 connection=0
cleanup() {
  status=$?
  trap - EXIT
  for pid in "$curl_pid" "$parser_pid" "$sleep_pid"; do
    [ -z "$pid" ] || { kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; }
  done
  [ -z "$pipe_dir" ] || { rm -f "$pipe_dir/stream" "$pipe_dir/response" "$pipe_dir/reconnect"; rmdir "$pipe_dir"; }
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
recovery() {
  jq -nr --arg delivery "subscription:$GITHUB_RUN_ID:${GITHUB_RUN_ATTEMPT:-1}:$connection:$1" --arg reason "$1" --arg status "${2:-}" \
    '"event: subscription_recovery\ndata: \(({event: "subscription_recovery", delivery: $delivery, writer: false, body: ({reason: $reason, status: $status} | tojson)} | tojson))\n"'
}
while true; do
  : > "$pipe_dir/response"
  : > "$pipe_dir/reconnect"
  # A recovery read during the outage cannot cover activity missed before the connection returns.
  [ "$connection" = 0 ] || recovery connection_restored > "$pipe_dir/reconnect"
  connection=$((connection + 1))
  started=$SECONDS
  # Separate children let cancellation interrupt wait and reap the entire subscription, including the frame parser.
  bash "$GITHUB_ACTION_PATH/scripts/sse-frames.sh" "$pipe_dir/response" "$pipe_dir/reconnect" < "$pipe_dir/stream" >> "$RUNNER_TEMP/sse.jsonl" &
  parser_pid=$!
  curl -ifsSN --suppress-connect-headers --connect-timeout 30 "$EVENTS_URL&pr=${PR_NUMBER:-}&sha=$HEAD_SHA&run=$GITHUB_RUN_ID" > "$pipe_dir/stream" 2>>"$RUNNER_TEMP/sse.err" &
  curl_pid=$!
  curl_status=0 parser_status=0 first_status=0 finished=
  wait -n -p finished "$curl_pid" "$parser_pid" || first_status=$?
  if [ "${finished:-}" = "$parser_pid" ]; then
    parser_status=$first_status; parser_pid=
    # Invalid headers or a failed writer must stop even a response body that never ends.
    if [ "$parser_status" != 0 ] || [ "$(cat "$pipe_dir/response")" != '200 text/event-stream' ]; then kill "$curl_pid" 2>/dev/null || true; fi
    wait "$curl_pid" || curl_status=$?; curl_pid=
  elif [ "${finished:-}" = "$curl_pid" ]; then
    curl_status=$first_status; curl_pid=
    wait "$parser_pid" || parser_status=$?; parser_pid=
  else
    # Both children can exit before wait -n observes a running job.
    wait "$curl_pid" || curl_status=$?; curl_pid=
    wait "$parser_pid" || parser_status=$?; parser_pid=
  fi
  [ "$parser_status" = 0 ] || exit "$parser_status"
  response=$(cat "$pipe_dir/response")
  if [ "$response" != '200 text/event-stream' ]; then
    printf 'Expected HTTP 200 text/event-stream, received %s (curl %s).\n' "${response:-no response}" "$curl_status" >> "$RUNNER_TEMP/sse.err"
    curl_status=invalid_response
  fi
  # Every EOF or timeout is an interruption. Coalesce failed retries, but report each established stream that ends.
  [ "$response" != '200 text/event-stream' ] || warned=
  if [ -z "$warned" ]; then
    recovery connection_failed "$curl_status" >> "$RUNNER_TEMP/sse.jsonl"
    warned=true
  fi
  # Short-lived streams also back off; reset after a connection has stayed healthy for at least a minute.
  if [ "$response" = '200 text/event-stream' ] && [ "$((SECONDS - started))" -ge 60 ]; then retry_delay=1; fi
  jitter=$((retry_delay / 4)); delay=$((retry_delay - jitter + RANDOM % (jitter + 1)))
  retry_delay=$((retry_delay * 2)); [ "$retry_delay" -le 30 ] || retry_delay=30
  sleep "$delay" & sleep_pid=$!
  wait "$sleep_pid"; sleep_pid=
done
