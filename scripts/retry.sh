#!/usr/bin/env bash
# Preserve stdin so retries can replay --input - payloads.
input=$(cat)
err=$(mktemp)
trap 'rm -f "$err"' EXIT
# gh api writes HTTP error bodies and any completed pages to stdout. Its caller
# needs the final attempt's response, including when the last request fails.
if [[ "$1" = gh && "$2" = api ]]; then
  response=$(mktemp) || exit 1
  finish() {
    local status=$?
    cat "$response" || status=1
    rm -f "$err" "$response"
    exit "$status"
  }
  trap finish EXIT
  gh() { command gh "$@" > "$response"; }
fi
# A bare decode error names no endpoint, so every failure says what failed and how often it was tried.
# GraphQL queries are the bulk of this argument list; the head of it still names the endpoint and its arguments.
give_up() {
  printf 'retry.sh: failed after %s attempt(s): %s\n' "${attempt:-1}" "$(printf '%.240s' "$*" | tr '\n' ' ')" >&2
  exit 1
}
# A request that may already have taken effect cannot be replayed, so an unreadable response ends it here.
writes=false
case " $* " in *" --input "* | *" -X "*) writes=true ;; esac
delay=1
max_delay=30
for attempt in 1 2 3 4 5 6 7 8; do
  if printf '%s' "$input" | "$@" 2> "$err"; then cat "$err" >&2; exit 0; fi
  cat "$err" >&2
  # A DELETE whose response was lost has already taken effect, so the retry's 404 means it is done.
  [[ " $* " != *" -X DELETE "* ]] || ! grep -q 'HTTP 404' "$err" || exit 0
  # gh reports HTTP statuses in parentheses; git/curl use "returned error: NNN".
  # A response takes precedence over transport-looking words in its message.
  error=$(cat "$err")
  if [[ "$error" =~ (HTTP\ |returned\ error:\ )([0-9]{3})([^0-9]|$) ]]; then
    status=${BASH_REMATCH[2]}
    if [[ "$status" = 403 || "$status" = 429 ]]; then
      # Secondary limits and bare throttles are transient; a primary quota resets on its own schedule.
      if grep -Eiq 'secondary rate limit|abuse detection' "$err" || { [[ "$status" = 429 ]] && ! grep -qi 'api rate limit exceeded' "$err"; }; then
        delay=$((delay < 60 ? 60 : delay))
        max_delay=300
      else
        give_up "$@"
      fi
    else
      [[ "$status" = 5?? ]] || give_up "$@"
    fi
  elif grep -q 'unexpected end of JSON input' "$err"; then
    # gh says this when a response body is empty or truncated: the request reached GitHub, the reply did not arrive whole.
    [[ "$writes" = false ]] || give_up "$@"
  else
    # GraphQL validation, local command errors and unknown failures are terminal.
    grep -Eiq \
      -e 'i/o timeout|TLS handshake timeout|Client.Timeout|context deadline exceeded|connection timed out|operation timed out' \
      -e 'connection (reset|refused|aborted)|could not resolve (host|proxy)|could not connect|failed to connect|error connecting to ' \
      -e 'the remote end hung up unexpectedly' \
      -e 'Something went wrong while executing your query' \
      -e 'no such host|temporary failure in name resolution|network is unreachable|(^|[^[:alnum:]])(unexpected )?EOF([^[:alnum:]]|$)' "$err" || give_up "$@"
  fi
  [ "$attempt" = 8 ] || sleep "$delay"
  delay=$((delay * 2 > max_delay ? max_delay : delay * 2))
done
give_up "$@"
