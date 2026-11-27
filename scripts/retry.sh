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
# A request that may already have taken effect cannot be replayed, so its unreadable response ends the run here.
# The endpoint decides the protocol, never a field value: `-f external_id='weekly graphql review'` is still REST,
# and `owner/mutation-testing` still names a GraphQL query. REST writes when the method is explicit, when `--input`
# supplies a body, or when a field flag switches it to POST; GraphQL writes only when its document mutates.
endpoint=
method=
document=
fields=false
writes=false
if [[ $1 == gh && $2 == api ]]; then
  # Consume each option together with its value, whether joined or separate. Only operands name endpoints.
  for ((index = 3; index <= $#; index++)); do
    arg=${!index}
    case $arg in
      --) ((index++)); endpoint=${endpoint:-${!index}}; break ;;
      --*) flag=${arg%%=*}; attached=${arg#"$flag"} ;;
      -*) # -i can precede a value-taking short flag, as in -iH.
        [[ $arg =~ ^-i*([XHfFqtp])(.*)$ ]] || continue
        flag=-${BASH_REMATCH[1]}; attached=${BASH_REMATCH[2]} ;;
      *) endpoint=$arg; continue ;;
    esac
    case $flag in
      -X | -H | -f | -F | -q | -t | -p | --method | --header | --field | --raw-field | --input | --jq | --template | --hostname | --cache | --preview) ;;
      *) continue ;;
    esac
    if [[ -n $attached ]]; then value=${attached#=}; else ((index++)); value=${!index}; fi
    case $flag in
      -X | --method) method=$value ;;
      --input) writes=true ;;
      -f | -F | --field | --raw-field)
        fields=true
        [[ $value == query=* ]] && document=${value#query=} ;;
    esac
  done
fi
if [[ $endpoint == graphql ]]; then
  # Only a document whose first significant token is `query` or a selection set reads; a comment,
  # a fragment definition or anything unrecognised keeps the write guard. No document at all is a read.
  if [[ -n $document ]]; then
    operation=$(printf '%s' "$document" | awk '{ sub(/^[ \t]+/, "") } /^#/ || !length { next } { print; exit }')
    [[ $operation =~ ^(\{|query([[:space:]{\(]|$)) ]] || writes=true
    # `operationName` can select a later mutation while the first definition is a query.
    if printf '%s' "$document" | grep -Eq '(^|[^[:alnum:]_])mutation([[:space:]({]|$)'; then writes=true; fi
  fi
elif [[ -n $method ]]; then
  # gh sends field flags as query parameters when GET is explicit.
  if [[ ${method^^} == GET ]]; then writes=false; else writes=true; fi
elif [[ $fields == true ]]; then
  writes=true
fi
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
  elif grep -Eiq 'unexpected end of JSON input|Something went wrong while executing your query' "$err"; then
    # A reply that never arrived whole, or a failed GraphQL execution, says nothing about whether a write committed.
    [[ "$writes" = false ]] || give_up "$@"
  elif grep -Eiq 'the remote end hung up unexpectedly|(^|[^[:alnum:]])(unexpected )?EOF([^[:alnum:]]|$)' "$err"; then
    # A dropped connection can follow a request the server already applied, so a write never replays it.
    [[ "$writes" = false ]] || give_up "$@"
  else
    # GraphQL validation, local command errors and unknown failures are terminal.
    grep -Eiq \
      -e 'i/o timeout|TLS handshake timeout|Client.Timeout|context deadline exceeded|connection timed out|operation timed out' \
      -e 'connection (reset|refused|aborted)|could not resolve (host|proxy)|could not connect|failed to connect|error connecting to ' \
      -e 'no such host|temporary failure in name resolution|network is unreachable' "$err" || give_up "$@"
  fi
  [ "$attempt" = 8 ] || sleep "$delay"
  delay=$((delay * 2 > max_delay ? max_delay : delay * 2))
done
give_up "$@"
