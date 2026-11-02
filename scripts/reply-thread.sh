#!/usr/bin/env bash
# Usage: reply-thread.sh <id of a comment in the thread> <reply>. Answers a review comment in its own thread, leaving the thread open.
set -eo pipefail
# Replying is not idempotent, so unlike resolving it is never retried.
gh api "repos/$GITHUB_REPOSITORY/pulls/$PR_NUMBER/comments/$1/replies" -f body="$2" > /dev/null
