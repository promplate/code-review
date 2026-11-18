#!/usr/bin/env bash
# Preserve stdin so retries can replay --input - payloads.
input=$(cat)
err=$(mktemp)
trap 'rm -f "$err"' EXIT
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
        exit 1
      fi
    else
      [[ "$status" = 5?? ]] || exit 1
    fi
  else
    # GraphQL validation, local command errors and unknown failures are terminal.
    grep -Eiq \
      -e 'i/o timeout|TLS handshake timeout|Client.Timeout|context deadline exceeded|connection timed out|operation timed out' \
      -e 'connection (reset|refused|aborted)|could not resolve (host|proxy)|could not connect|failed to connect|error connecting to ' \
      -e 'the remote end hung up unexpectedly' \
      -e 'no such host|temporary failure in name resolution|network is unreachable|(^|[^[:alnum:]])(unexpected )?EOF([^[:alnum:]]|$)' "$err" || exit 1
  fi
  [ "$attempt" = 8 ] || sleep "$delay"
  delay=$((delay * 2 > max_delay ? max_delay : delay * 2))
done
exit 1
