#!/usr/bin/env bash
# Usage: resolve-thread.sh <id of any comment in the thread> <reply>.
set -eo pipefail
helper="$GITHUB_ACTION_PATH/scripts/review-threads.sh"
thread=$(bash "$helper" lookup "$1")
exec bash "$helper" resolve "$thread" --reply "$2"
