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
# $1 is gh and $2 the api subcommand, so the endpoint is the first operand after them.
# Options may precede it and some take a separate value (`-H "header"`), which is not the endpoint.
value_flags=" -X --method -H --header -f --field -F --raw-field --input -q --jq -t --template --hostname --cache "
skip_value=false
for ((index = 3; index <= $#; index++)); do
  if [[ $skip_value == true ]]; then skip_value=false; continue; fi
  case " $value_flags " in *" ${!index} "*) skip_value=true; continue ;; esac
  [[ ${!index} == -* ]] || { endpoint=${!index}; break; }
done
writes=false
if [[ $1 != gh || $2 != api ]]; then
  : # Other commands carry no endpoints to read; their transient failures retry on the message alone.
elif [[ $endpoint == graphql ]]; then
  document=
  for ((index = 2; index <= $#; index++)); do
    case ${!index} in
      -f | --field | -F | --raw-field)
        next=$((index + 1)); value=${!next}
        [[ $value == query=* ]] && document=${value#query=} ;;
      query=*) value=${!index}; document=${value#query=} ;;
      --input) writes=true ;;
    esac
  done
  # Only a document whose first significant token is `query` or a selection set reads; a comment,
  # a fragment definition or anything unrecognised keeps the write guard. No document at all is a read.
  if [[ -n $document ]]; then
    operation=$(printf '%s' "$document" | awk '{ sub(/^[ \t]+/, "") } /^#/ || !length { next } { print; exit }')
    [[ $operation =~ ^(\{|query([[:space:]{]|$)) ]] || writes=true
  fi
else
  # An explicit method decides first: `--method GET` keeps field flags as query parameters,
  # while REST's field flags otherwise switch the call to POST by themselves.
  method=
  for ((index = 2; index <= $#; index++)); do
    case ${!index} in
      -X | --method) next=$((index + 1)); method=${!next} ;;
    esac
  done
  if [[ -n $method && ${method^^} != GET ]]; then
    writes=true
  elif [[ -z $method ]]; then
    case " $* " in
      *" --input "* | *" -f "* | *" --field "* | *" -F "* | *" --raw-field "*) writes=true ;;
    esac
  fi
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
