#!/usr/bin/env bash
# Usage: resolve-thread.sh <id of any comment in the thread> <reply>. Answers a review thread a fix settled and resolves it.
set -eo pipefail
thread=$(bash "$GITHUB_ACTION_PATH/scripts/retry.sh" gh api graphql -f owner="${GITHUB_REPOSITORY%/*}" -f name="${GITHUB_REPOSITORY#*/}" -F pr="$PR_NUMBER" \
  -f query='query($owner: String!, $name: String!, $pr: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $pr) { reviewThreads(first: 100) { nodes { id comments(first: 100) { nodes { databaseId } } } } } } }' \
  --jq ".data.repository.pullRequest.reviewThreads.nodes[] | select(any(.comments.nodes[]; .databaseId == $1)) | .id" < /dev/null)
# Replying is not idempotent, so unlike resolving it is never retried.
gh api graphql -f id="$thread" -f body="$2" -f query='mutation($id: ID!, $body: String!) { addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $id, body: $body}) { comment { id } } }' > /dev/null
bash "$GITHUB_ACTION_PATH/scripts/retry.sh" gh api graphql -f id="$thread" -f query='mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { isResolved } } }' > /dev/null < /dev/null
