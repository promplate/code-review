#!/usr/bin/env bash
# Usage: resolve-thread.sh <id of any comment in the thread> <reply>.
set -eo pipefail
[ -n "${PR_NUMBER:-}" ] || { echo 'resolve-thread.sh requires PR_NUMBER to identify the pull request.' >&2; exit 1; }
helper="$GITHUB_ACTION_PATH/scripts/review-threads.sh"
thread=$(bash "$helper" lookup "$1")
exec bash "$helper" resolve "$thread" --reply "$2"
