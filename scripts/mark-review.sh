#!/usr/bin/env bash
# Source to retain the reaction identifiers for cleanup.
# The eyes marks the message this run answers: a comment gets its own reaction, while reviews have no reactions endpoint and a deleted comment has nothing to mark.
subject="issues/$PR_NUMBER/reactions"
if [ "$(jq -r '.action // ""' "$GITHUB_EVENT_PATH")" != deleted ]; then
  comment=$(jq -r '.comment.id // empty' "$GITHUB_EVENT_PATH")
  case "$GITHUB_EVENT_NAME" in
    issue_comment) [ -z "$comment" ] || subject="issues/comments/$comment/reactions" ;;
    pull_request_review_comment) [ -z "$comment" ] || subject="pulls/comments/$comment/reactions" ;;
  esac
fi
id=$(bash "$GITHUB_ACTION_PATH/scripts/retry.sh" gh api "repos/$GITHUB_REPOSITORY/$subject" -f content=eyes --jq .id </dev/null) || {
  # A comment can disappear after its webhook was queued; the PR body remains a usable target.
  [ "$subject" != "issues/$PR_NUMBER/reactions" ] || exit 1
  subject="issues/$PR_NUMBER/reactions"
  id=$(bash "$GITHUB_ACTION_PATH/scripts/retry.sh" gh api "repos/$GITHUB_REPOSITORY/$subject" -f content=eyes --jq .id </dev/null)
}
[ -n "$id" ] || exit 1
export EYES_REACTION_PATH="$subject/$id" EYES_REACTION_ID="$id"
