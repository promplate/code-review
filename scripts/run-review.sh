#!/usr/bin/env bash
set -eo pipefail
# Actions starts this step in a fresh shell and restores the job environment;
# configure-review.sh cannot remove inherited project credentials for this step.
if [ -n "${REVIEW_TRACE_RELAY_URL:-}" ]; then
  export TRACE_TO_LANGFUSE=false
  unset LANGFUSE_PUBLIC_KEY LANGFUSE_SECRET_KEY LANGFUSE_CODEX_PUBLIC_KEY LANGFUSE_CODEX_SECRET_KEY
fi
# Prices come from https://github.com/pydantic/genai-prices; installing it while Codex reviews keeps it off the critical path.
# Start it in this step so the shell that reports usage can wait for its own child.
(mkdir -p "$RUNNER_TEMP/prices" && cd "$RUNNER_TEMP/prices" && bun add --silent @pydantic/genai-prices > install.log 2>&1) &
PRICE_PID=$!
[ "$AGENT" = true ] || bash "$GITHUB_ACTION_PATH/scripts/retry.sh" gh api repos/$GITHUB_REPOSITORY/check-runs/$CHECK_ID -X PATCH \
  -f "output[title]=Reviewing…" -f "output[summary]=Codex is reading the diff." </dev/null > /dev/null
jq -n --arg sha "$HEAD_SHA" --arg id "$CHECK_ID" '{sha: $sha, id: $id}' >> "$CODEX_HOME/check-runs.jsonl"
# Seed the hook receipts from the restored session before processing new activity.
if [ -f "$CODEX_HOME/sessions/.github-deliveries.json" ]; then jq -r '.[]' "$CODEX_HOME/sessions/.github-deliveries.json" > "$RUNNER_TEMP/injected-deliveries.log"; else : > "$RUNNER_TEMP/injected-deliveries.log"; fi
rm -f "$RUNNER_TEMP/injected.size"
if [ "$AGENT" = true ]; then
  SUBJECT="issue #$ISSUE_NUMBER" MENTION="#$ISSUE_NUMBER" COMMENT="gh issue comment $ISSUE_NUMBER --body-file -"
elif [ -n "$PR_NUMBER" ]; then
  SUBJECT="PR #$PR_NUMBER" MENTION="#$PR_NUMBER" RANGE="origin/$BASE...HEAD" COMMENT="gh pr comment $PR_NUMBER --body-file -"
  MODE_INSTRUCTIONS="If the PR is merged or closed before your review ends, nothing waits for your verdict anymore: point out must-fix issues in a PR comment, editing your latest comment if nothing follows it, and fix certain ones in a separate PR as above rather than on this PR's branch. \
    In the PR title and description, fix only slips you are 100% sure are accidental, such as obvious typos, links or SHAs broken while pasting, stray spaces and unclosed backticks, and never change wording or meaning, except retitle a PR whose title clearly misdescribes the change, such as after commits changed its scope, the way merged PRs here are titled. \
    Edit them via gh api -X PATCH repos/$GITHUB_REPOSITORY/pulls/$PR_NUMBER -f title='<title>' or -F body=@-, and reply about it only when useful."
  # A ready PR that no longer merges cleanly still needs someone to merge its base in.
  git merge-tree --write-tree "origin/$BASE" HEAD > /dev/null || CONFLICT="The PR conflicts with $BASE: if it is otherwise ready to merge, run git merge origin/$BASE, resolve the conflicts where the intent of both sides is clear, and commit the merge on its own with commit-fix.sh, passing the resolved paths and a subject like earlier merges in git log, then explain in a PR comment any resolution that is more than keeping both sides; otherwise point out the conflict. "
else
  SUBJECT="branch $HEAD_BRANCH" MENTION=$HEAD_SHA COMMENT="gh api repos/$GITHUB_REPOSITORY/commits/<sha>/comments -F body=@-"
  # A dispatch names the commit to review, and reviews exactly what it brings: from the base it names, or from its parent.
  if [ -n "$DISPATCHED_SHA" ]; then
    RANGE="${DISPATCHED_BASE:-$(git rev-parse "$HEAD_SHA^")}..HEAD"
  else
    # Pending runs that newer pushes replace never start, so continue from the last head this session reviewed; new branches and force pushes may leave no such commit.
    RANGE="$(jq -rs 'map(.sha) | .[-2] // env.BEFORE' "$CODEX_HOME/check-runs.jsonl")..HEAD"
    git cat-file -e "${RANGE%..HEAD}^{commit}" 2>/dev/null || RANGE="origin/$BASE...HEAD"
  fi
  # Nobody owns a branch push, but the default branch is not ours to rewrite either; other branches accept fixes directly.
  [ "$HEAD_BRANCH" != "$BASE" ] || FIX_POLICY="for certain fixes, open a PR as above rather than committing with commit-fix.sh"
  MODE_INSTRUCTIONS="This review covers pushes to $HEAD_BRANCH outside any PR, so nobody awaits replies: ${FIX_POLICY:-commit certain fixes as usual}, and otherwise stay silent unless a human must act, which should be rare, and then comment on the relevant commit. \
    Commits that landed through a reviewed PR need only a look at what merging could break."
fi
# The run script is a template with a 21 kB limit, so the prompts live beside the other scripts.
. "$GITHUB_ACTION_PATH/scripts/instructions.sh"
if [ "$AGENT" = true ]; then INSTRUCTIONS="$AGENT_INSTRUCTIONS"; else INSTRUCTIONS="$REVIEW_INSTRUCTIONS"; fi
# The caller appends repository rules after the built-in prompt, so they can override it without replacing it.
[ -z "$EXTRA_INSTRUCTIONS" ] || INSTRUCTIONS="$INSTRUCTIONS"$'\n\n'"$EXTRA_INSTRUCTIONS"
# Production reviews may opt into a faster provider tier; workflows that do not ask for one keep the provider default.
tier=()
case "$SERVICE_TIER" in
  ''|default) ;;
  *) tier=(--config "service_tier=\"$SERVICE_TIER\"" --config features.ultrafast_mode=true) ;;
esac
# An agent turn ends in the actions it took, so it writes no verdict object to parse.
SCHEMA=(--output-schema "$GITHUB_ACTION_PATH/review-schema.json" --output-last-message "$RUNNER_TEMP/review.json")
OPEN="Review $SUBJECT: run \`git diff $RANGE\` and inspect the changed files. $CONFLICT$INSTRUCTIONS"
CONTINUE="Continue reviewing $SUBJECT. The workspace is a fresh checkout at the current HEAD; do not rely on earlier filesystem state or artifacts. Run \`git diff $RANGE\`, \
     re-check what changed, reply to the activity the hooks report, and output the JSON review covering what this run saw. $CONFLICT$INSTRUCTIONS"
if [ "$AGENT" = true ]; then
  # An agent turn posts no verdict, but its closing message is what the run page shows as the summary.
  SCHEMA=(--output-last-message "$RUNNER_TEMP/last-message.md")
  # The event is delivered in the shape the hooks inject into a running review, so both paths read the same context.
  delivery=$(jq -c --arg event "$GITHUB_EVENT_NAME" '{event: $event, action: .action, actor: .sender.login, url: (.issue.html_url // .comment.html_url), comment: .comment.body, comment_id: .comment.id} | with_entries(select(.value != null))' "$GITHUB_EVENT_PATH")
  OPEN=$(printf 'New GitHub activity on %s:\n%s\nRead the issue and its discussion with `gh issue view %s --comments`; the checkout is %s at %s. Decide what response, if any, it calls for and do it. %s' \
    "$SUBJECT" "$delivery" "$ISSUE_NUMBER" "$BASE" "$HEAD_SHA" "$INSTRUCTIONS")
  CONTINUE=$(printf 'New GitHub activity on %s:\n%s\nContinue what you were doing in a fresh checkout at %s; do not rely on earlier filesystem state or artifacts. Re-read the issue if the discussion moved on, finish the response, and reply there. %s' \
    "$SUBJECT" "$delivery" "$HEAD_SHA" "$INSTRUCTIONS")
fi
fresh() {
  $CODEX_RUNTIME "$CODEX_BIN" exec --json --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust ${tier[@]+"${tier[@]}"} ${SCHEMA[@]+"${SCHEMA[@]}"} \
    "$OPEN"
}
log() { jq --unbuffered -rR --arg stop "$(openssl rand -hex 16)" -f "$GITHUB_ACTION_PATH/scripts/codex-log.jq"; }
# Hook deliveries never reach the exec stream, so the hook writes them aside and this tail shows them as they land.
# This writer escapes command syntax instead of stopping commands, since the tool log above holds the runner's one suppression token.
: > "$RUNNER_TEMP/injected.log"
tail -f "$RUNNER_TEMP/injected.log" 2> /dev/null | jq --unbuffered -rR -f "$GITHUB_ACTION_PATH/scripts/injected-log.jq" &
INJECTED_TAIL=$!
trap 'kill "$INJECTED_TAIL" 2> /dev/null || true' EXIT
review() {
if [ -n "$FORK_KEY" ]; then
  fork=$RUNNER_TEMP/code-review-homes/$GITHUB_REPOSITORY/$FORK_KEY
  [ ! -d "$CODEX_HOME/fork" ] || fork=$CODEX_HOME/fork
  cp -R "$fork/sessions" "$fork/last-thread-id" "$CODEX_HOME/"
  # The conversation transfers, but events filtered for the source PR were never consumed for this one.
  rm -f "$CODEX_HOME/sessions/.github-deliveries.json" "$CODEX_HOME/sessions/.github-published-head"
  $CODEX_RUNTIME "$CODEX_BIN" exec fork --json --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust ${tier[@]+"${tier[@]}"} \
    --output-schema "$GITHUB_ACTION_PATH/review-schema.json" \
    --output-last-message "$RUNNER_TEMP/review.json" \
    "$(cat "$CODEX_HOME/last-thread-id")" \
    "You opened PR #$PR_NUMBER to keep that fix out of the change you were reviewing; now review it as its own PR. The workspace is a fresh checkout of its head; do not rely on earlier filesystem state or artifacts. \
     Run \`git diff $RANGE\`, inspect the changed files, and output the JSON review for PR #$PR_NUMBER. $INSTRUCTIONS"
elif [ -s "$CODEX_HOME/last-thread-id" ]; then
  $CODEX_RUNTIME "$CODEX_BIN" exec resume --json --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust ${tier[@]+"${tier[@]}"} ${SCHEMA[@]+"${SCHEMA[@]}"} \
    "$(cat "$CODEX_HOME/last-thread-id")" \
    "$CONTINUE"
else
  fresh
fi
}
ran=0
review < /dev/null 2>&1 | tee "$RUNNER_TEMP/codex.jsonl" | log && ran=1
# A thread recorded under another model or provider cannot be replayed or resumed; its work is lost, the review is not.
# Only a failed resume itself counts: the same words inside agent output are not a reason to start over.
if grep -Eq '^(Error: .*|.*"type":"(error|turn\.failed)".*)(unsupported_persisted_item_context|modelProviderMismatch)' "$RUNNER_TEMP/codex.jsonl"; then
  echo "::warning::The saved session cannot continue here; reviewing from a new thread."
  rm -f "$CODEX_HOME/last-thread-id"
  : > "$RUNNER_TEMP/codex.jsonl"
  fresh < /dev/null 2>&1 | tee "$RUNNER_TEMP/codex.jsonl" | log && ran=1
fi
# A turn that fails after the review is complete, such as when the provider is at capacity for the next turn, still leaves the verdict it produced.
[ "$AGENT" = true ] || [ "$ran" = 1 ] || jq -Rrs '[split("\n")[] | fromjson? // empty | select(.type == "item.completed" and .item.type == "agent_message") | .item.text] | last // empty' \
  < "$RUNNER_TEMP/codex.jsonl" > "$RUNNER_TEMP/review.json"
# Recorded before the verdict check, so a fresh review can resume the thread it just started.
jq -Rrs '[split("\n")[] | fromjson? // empty | select(.type == "thread.started")] | first | .thread_id // empty' \
  < "$RUNNER_TEMP/codex.jsonl" > "$CODEX_HOME/last-thread-id"
# A turn can end without a verdict, such as when the model stops to report progress; ask once more and let it name what it still does not know.
# A commit without a conclusion, or without the one being reviewed, would fail the publish step instead of this one.
# A failure that names nothing is unreadable on the pull request, so it is asked again like a missing verdict.
# The review's own verdict and the head's check run are what readers see; an older commit that introduced a defect keeps its failure.
verdict() { jq -e '.summary and (.commits | type == "array" and length > 0) and all(.commits[]; .conclusion == "success" or .conclusion == "failure") and any(.commits[]; .sha == env.HEAD_SHA)
  and (if .conclusion == "failure" or any(.commits[]; .sha == env.HEAD_SHA and .conclusion == "failure") then (.summary | test("\\S")) or any(.annotations[]; .level == "failure") else true end)' "$RUNNER_TEMP/review.json" > /dev/null 2>&1; }
# A hosted run can see the new head through live activity while its check still belongs to the scheduled head.
supersede_stale_hosted_check() {
  [ "$REVIEW_HOSTED" != true ] || bash "$GITHUB_ACTION_PATH/scripts/publish-check.sh" --superseded-only
}
if [ "$AGENT" != true ] && ! verdict && [ -s "$CODEX_HOME/last-thread-id" ]; then
  supersede_stale_hosted_check
  if [ ! -s "$RUNNER_TEMP/superseded" ]; then
    # A capacity error leaves the thread intact but clears on its own schedule; one pause is cheaper than a failed review.
    if grep -Eq 'capacity|overloaded|too many requests' "$RUNNER_TEMP/codex.jsonl"; then sleep 30; fi
    echo "::warning::Codex ended without a verdict; asking for the review object once."
    $CODEX_RUNTIME "$CODEX_BIN" exec resume --json --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust ${tier[@]+"${tier[@]}"} \
      --output-schema "$GITHUB_ACTION_PATH/review-schema.json" \
      --output-last-message "$RUNNER_TEMP/review.json" \
      "$(cat "$CODEX_HOME/last-thread-id")" \
      "Reply with the full review JSON for $SUBJECT now, running no further commands, with every field named as in $GITHUB_ACTION_PATH/review-schema.json. Include a commits entry for $HEAD_SHA — the commit this run publishes for. Put whatever remains unknown into the summary and judge on what you verified." \
      < /dev/null 2>&1 | tee -a "$RUNNER_TEMP/codex.jsonl" | jq --unbuffered -rR --arg stop "$(openssl rand -hex 16)" -f "$GITHUB_ACTION_PATH/scripts/codex-log.jq" || {
        retry_status=$?
        supersede_stale_hosted_check
        [ -s "$RUNNER_TEMP/superseded" ] || exit "$retry_status"
      }
  fi
fi
# Tokens spent on this run, summed over every turn the hooks and the extra ask started.
# The line and the turns the price reads come from one pass, so the price judges the same turns the counts describe.
{ read -r usage; read -r turns; } < <(jq -Rrs '
  def h: if . >= 1000000 then "\(. / 100000 | round / 10)M" elif . >= 1000 then "\(. / 100 | round / 10)k" else "\(.)" end;
  [split("\n")[] | fromjson? // empty | select(.type == "turn.completed") | .usage] as $turns
  | ($turns | map(.input_tokens) | add // 0) as $input
  | ($turns | map(.cached_input_tokens) | add // 0) as $cached
  | ($turns | map(.output_tokens) | add // 0) as $output
  | ($turns | map(.reasoning_output_tokens) | add // 0) as $reasoning
  | ("\($turns | length) turns · \($input | h) input, \(if $input > 0 then $cached * 1000 / $input | round / 10 else 0 end)% cached · \($output | h) output, \(if $output > 0 then $reasoning * 1000 / $output | round / 10 else 0 end)% reasoning",
     ($turns | map({input_tokens, cache_read_tokens: .cached_input_tokens, output_tokens}) | tojson))' < "$RUNNER_TEMP/codex.jsonl")
# Each turn is priced on its own: a size tier applies per request, so summing first would charge every token at the tier the total reached.
# The provider is whatever the config points at, and a model the table does not know has no price at all.
wait "$PRICE_PID" || true
price=$(cd "$RUNNER_TEMP/prices" 2>/dev/null && TURNS="$turns" bun -e '
  import { calcPrice } from "@pydantic/genai-prices";
  // A tier that codex-config sets applies even when this input names none.
  let tier = process.env.SERVICE_TIER;
  if (!tier || tier === "default") {
    const config = Bun.file(`${process.env.CODEX_HOME}/config.toml`);
    tier = await config.exists() ? Bun.TOML.parse(await config.text()).service_tier : undefined;
  }
  const options = !tier || tier === "default" ? undefined : { priceContext: { service_tier: tier } };
  const turns = JSON.parse(process.env.TURNS);
  const prices = turns.map((usage) => calcPrice(usage, process.env.MODEL_NAME, options));
  // Size tiers combine requests this log cannot separate, and a requested service tier may be downgraded.
  if (prices.length && prices.every(Boolean)) {
    const total = prices.reduce((sum, price) => sum + price.total_price, 0);
    const tiered = prices.some(({ model_price }) => [model_price.input_mtok, model_price.output_mtok].some((rate) => rate !== null && typeof rate === "object"));
    console.log(`${tiered || options ? "~" : ""}$${total.toFixed(total < 1 ? 3 : 2)}`);
  }
') || { echo "::warning::The price table could not be read; reporting usage without a price."; price=""; }
detail="$usage${price:+ · $price}"
echo "::notice::$MODEL_NAME usage: $detail"
echo "**$MODEL_NAME usage** — $detail" >> "$GITHUB_STEP_SUMMARY"
[ "$AGENT" != true ] || [ "$ran" = 1 ] || { echo "::error::Codex failed before completing the issue run."; exit 1; }
# Draft fix PRs opened during the review outlive this runner; keep their URLs beside the session so a retry can still mark them ready.
mkdir -p "$CODEX_HOME/sessions"
[ ! -s "$RUNNER_TEMP/forked-prs" ] || cat "$RUNNER_TEMP/forked-prs" >> "$CODEX_HOME/sessions/.github-pending-drafts"
# Failing here leaves a red check the author cannot read, so the response that failed is posted where they do read.
if [ "$AGENT" != true ] && [ ! -s "$RUNNER_TEMP/superseded" ] && ! verdict; then
  supersede_stale_hosted_check
  [ ! -s "$RUNNER_TEMP/superseded" ] || exit 0
  # Branch instructions leave the commit to the reviewer; this diagnostic belongs to the reviewed head.
  [ ! -s "$RUNNER_TEMP/review.json" ] || printf 'This review ended without a usable verdict. The reviewer returned:\n\n```json\n%s\n```\n' \
    "$(head -c 2000 "$RUNNER_TEMP/review.json")" | ${COMMENT//<sha>/$HEAD_SHA} || true
  echo "::error::Codex returned no verdict: $(head -c 300 "$RUNNER_TEMP/review.json" 2>/dev/null)"
  exit 1
fi
