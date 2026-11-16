#!/usr/bin/env bash
# The caller owns VM lifetime, repository authorization, credentials, and durable session storage.
set -eo pipefail
: "${GITHUB_ACTION_PATH:?Path to the pinned code-review source}"
: "${GITHUB_REPOSITORY:?Repository full name}"
: "${PR_NUMBER:?Pull request number}"
: "${HEAD_SHA:?Commit selected by the coordinator}"
: "${CODEX_HOME:?Persistent Codex session directory}"
: "${RUNNER_TEMP:?Private directory for this attempt}"
: "${GH_CONFIG_DIR:?Directory containing the repository-scoped gh credential}"
: "${BOT_LOGIN:?GitHub App login}"
: "${GITHUB_EVENT_PATH:?Verified event payload}"
: "${ACTIVITY_ID:?Stable event identity}"
: "${DETAILS_URL:?Authenticated platform run page}"
export REVIEW_HOSTED=true GITHUB_SERVER_URL=https://github.com AGENT=false
export GITHUB_EVENT_NAME="${EVENT_NAME:-pull_request}" SESSION_KEY="${SESSION_KEY:-pr-$PR_NUMBER}"
export GITHUB_RUN_ID="${REVIEW_RUN_ID:-$ACTIVITY_ID}" GITHUB_RUN_ATTEMPT="${REVIEW_RUN_ATTEMPT:-1}"
export GITHUB_STEP_SUMMARY="$RUNNER_TEMP/summary.md"
export UV_CACHE_DIR="$RUNNER_TEMP/uv/cache" UV_TOOL_DIR="$RUNNER_TEMP/uv/tools" UV_PYTHON_INSTALL_DIR="$RUNNER_TEMP/uv/python"
mkdir -p "$CODEX_HOME/sessions" "$RUNNER_TEMP"
umask 077
rm -f "$RUNNER_TEMP/superseded" "$RUNNER_TEMP/review.json" "$RUNNER_TEMP/result.json"
SSE_PID= published=false check_published=false
retry() { bash "$GITHUB_ACTION_PATH/scripts/retry.sh" "$@"; }
result() {
  jq -n --arg status "$1" --arg sha "$HEAD_SHA" --arg current "${2:-}" --arg check "${CHECK_ID:-}" --argjson published "$published" \
    '{status: $status, headSha: $sha, currentHead: (if $current == "" then null else $current end), checkId: $check, published: $published}' > "$RUNNER_TEMP/result.json"
}
cleanup() {
  code=$?
  trap - EXIT
  [ -z "$SSE_PID" ] || { kill "$SSE_PID" 2>/dev/null || true; wait "$SSE_PID" 2>/dev/null || true; }
  if [ "$code" != 0 ]; then
    result failed
    if [ -n "${CHECK_ID:-}" ] && [ "$check_published" != true ]; then
      retry gh api "repos/$GITHUB_REPOSITORY/check-runs/$CHECK_ID" -X PATCH -f status=completed -f conclusion=neutral \
        -f 'output[title]=Review failed' -f 'output[summary]=The hosted review failed before completing publication. See the platform run for details.' </dev/null >/dev/null || true
    fi
  fi
  [ -z "${EYES_REACTION_PATH:-}" ] || retry gh api "repos/$GITHUB_REPOSITORY/$EYES_REACTION_PATH" -X DELETE </dev/null >/dev/null || true
  rm -rf "$CODEX_HOME/.tmp"
  exit "$code"
}
trap cleanup EXIT
pr=$(retry gh api "repos/$GITHUB_REPOSITORY/pulls/$PR_NUMBER" </dev/null)
current=$(jq -r .head.sha <<< "$pr")
if ! jq -e --arg repo "$GITHUB_REPOSITORY" '.head.repo.full_name == $repo' <<< "$pr" >/dev/null; then result skipped; exit 0; fi
if [ "$current" != "$HEAD_SHA" ]; then result superseded "$current"; exit 0; fi
export HEAD_BRANCH="$(jq -r .head.ref <<< "$pr")" BASE="$(jq -r .base.ref <<< "$pr")" PR_AUTHOR="$(jq -r .user.login <<< "$pr")"
if [ "$PR_AUTHOR" = "$BOT_LOGIN" ] && [ "$(jq -r .draft <<< "$pr")" = true ]; then result skipped; exit 0; fi
if [ -z "${DEFAULT_BRANCH:-}" ]; then DEFAULT_BRANCH=$(retry gh api "repos/$GITHUB_REPOSITORY" --jq .default_branch </dev/null); fi
export DEFAULT_BRANCH
export TRIGGER_SENDER="$(jq -r '.sender.login // "unknown"' "$GITHUB_EVENT_PATH")" TRIGGER_TYPE="$(jq -r '.sender.type // "unknown"' "$GITHUB_EVENT_PATH")"
# The checkout must be exactly the authorized head; a cached worktree cannot silently review another revision.
[ "$(git rev-parse HEAD)" = "$HEAD_SHA" ] || { echo 'Checkout does not match the scheduled head' >&2; exit 1; }
# A matching checkpoint only consumes a repeated delivery; new discussion still gets a fresh pass.
if [ "$(cat "$CODEX_HOME/sessions/.github-published-head" 2>/dev/null || true)" = "$HEAD_SHA" ] && \
  [ -f "$CODEX_HOME/sessions/.github-deliveries.json" ] && jq -e --arg id "$ACTIVITY_ID" 'index($id)' "$CODEX_HOME/sessions/.github-deliveries.json" >/dev/null; then
  result skipped; exit 0
fi
if [ -z "${CHECK_ID:-}" ]; then
  CHECK_ID=$(retry gh api "repos/$GITHUB_REPOSITORY/check-runs" -f name=code-review -f head_sha="$HEAD_SHA" -f status=in_progress \
    -f details_url="$DETAILS_URL" -f "external_id=$SESSION_KEY" -f 'output[title]=Restoring the Codex session…' -f 'output[summary]=Preparing the hosted review.' --jq .id </dev/null)
else
  retry gh api "repos/$GITHUB_REPOSITORY/check-runs/$CHECK_ID" -X PATCH -f status=in_progress -f details_url="$DETAILS_URL" </dev/null >/dev/null
fi
export CHECK_ID
. "$GITHUB_ACTION_PATH/scripts/mark-review.sh"
jq -nr --arg event "$GITHUB_EVENT_NAME" --arg delivery "$ACTIVITY_ID" --argjson writer "${ACTIVITY_WRITER:-false}" --rawfile body "$GITHUB_EVENT_PATH" \
  '"id: \($delivery)\nevent: \($event)\ndata: \(({receivedAt: (now * 1000 | floor), event: $event, delivery: $delivery, body: $body, writer: $writer} | tojson))\n"' > "$RUNNER_TEMP/sse.jsonl"
if [ -n "${EVENTS_URL:-}" ]; then bash "$GITHUB_ACTION_PATH/scripts/subscribe.sh" > "$RUNNER_TEMP/sse.err" 2>&1 & SSE_PID=$!; fi
. "$GITHUB_ACTION_PATH/scripts/configure-review.sh"
export MODEL_NAME="$(bun -e 'const c=Bun.TOML.parse(await Bun.file(process.argv[1]).text()); console.log(c.model || "default")' "$CODEX_HOME/config.toml")"
bash "$GITHUB_ACTION_PATH/scripts/run-review.sh"
bash "$GITHUB_ACTION_PATH/scripts/publish-check.sh"
check_published=true
if [ -f "$RUNNER_TEMP/superseded" ]; then result superseded "$(cat "$RUNNER_TEMP/superseded")"; exit 0; fi
bash "$GITHUB_ACTION_PATH/scripts/publish-commits.sh"
bash "$GITHUB_ACTION_PATH/scripts/publish-pr.sh"
if [ -f "$RUNNER_TEMP/superseded" ]; then result superseded "$(cat "$RUNNER_TEMP/superseded")"; exit 0; fi
bash "$GITHUB_ACTION_PATH/scripts/finish-reactions.sh"
EYES_REACTION_ID= EYES_REACTION_PATH=
bash "$GITHUB_ACTION_PATH/scripts/checkpoint-review.sh"
published=true
[ "$PR_AUTHOR" = "$BOT_LOGIN" ] || bash "$GITHUB_ACTION_PATH/scripts/merge-review.sh"
result completed
