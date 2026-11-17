#!/usr/bin/env bash
# Review threads on $GITHUB_REPOSITORY's $PR_NUMBER. list prints a JSON array, lookup prints a thread ID.
set -euo pipefail
usage() {
  echo 'Usage: review-threads.sh list | lookup <REST comment id> | resolve <threadId> [--reply <body>] | unresolve <threadId>' >&2
  exit 2
}

read_api() {
  # A failed request can print an error body or a partial set of pages before the retry.
  bash "$GITHUB_ACTION_PATH/scripts/retry.sh" bash -c 'response=$(gh api "$@") && printf "%s\n" "$response"' _ "$@" </dev/null
}

list_threads() {
  local pages
  pages=$(read_api graphql --paginate -f owner="${GITHUB_REPOSITORY%/*}" -f name="${GITHUB_REPOSITORY#*/}" -F number="$PR_NUMBER" -f query='
    query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
      repository(owner: $owner, name: $name) { pullRequest(number: $number) {
        reviewThreads(first: 100, after: $endCursor) { pageInfo { hasNextPage endCursor }
          nodes { id path line isResolved isOutdated resolvedBy { login }
            comments(first: 1) { nodes { fullDatabaseId body author { login } } } } } } } }') || return
  jq -cs '[.[].data.repository.pullRequest.reviewThreads.nodes[] | {threadId: .id, path, line, isResolved, isOutdated,
    resolvedBy: .resolvedBy.login, firstComment: (.comments.nodes[0] | if . then {id: .fullDatabaseId, body, author: .author.login} else null end)}]' <<< "$pages"
}

case "${1:-}" in
  list)
    [[ $# == 1 ]] || usage
    list_threads
    ;;
  lookup)
    [[ $# == 2 && $2 =~ ^[1-9][0-9]*$ ]] || usage
    # REST points replies at the first comment, even when the reply is on a later page.
    root=$(read_api "repos/$GITHUB_REPOSITORY/pulls/comments/$2" --jq '.in_reply_to_id // .id')
    list_threads | jq -er --arg id "$root" 'first(.[] | select(.firstComment.id == $id) | .threadId) // error("Comment has no thread on this PR")'
    ;;
  resolve|unresolve)
    [[ $# == 2 || ( $1 == resolve && $# == 4 && $3 == --reply && -n $4 ) ]] || usage
    # Mutations take a global node ID. Check it belongs to this PR before writing.
    list_threads | jq -e --arg id "$2" 'any(.[]; .threadId == $id) or error("Unknown thread on this PR")' >/dev/null
    if [[ $# == 4 ]]; then
      # A lost response could mean GitHub already posted the reply. Never retry it.
      gh api graphql -f id="$2" -f body="$4" -f query='mutation($id: ID!, $body: String!) {
        addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $id, body: $body}) { comment { id } } }' >/dev/null
    fi
    bash "$GITHUB_ACTION_PATH/scripts/retry.sh" gh api graphql -f id="$2" -f query="mutation(\$id: ID!) {
      ${1}ReviewThread(input: {threadId: \$id}) { thread { isResolved } } }" </dev/null >/dev/null
    ;;
  *) usage ;;
esac
