# Codex Code Review

Reviews same-repository pull requests, and optionally branch pushes, with [Codex](https://github.com/openai/codex "openai/codex") as the [muspi-merol-review](https://github.com/apps/muspi-merol-review "muspi-merol-review GitHub App") GitHub App:

- a `code-review` check run per commit, with annotations on the reviewed head
- `REQUEST_CHANGES` with inline threads for must-fix issues only, `APPROVE` otherwise; a finding an unresolved thread already carries is not posted again
- everything else as regular PR comments, answers to review comments in their thread
- certain fixes committed to the PR, or opened as separate PRs when out of scope; fixes touching `.github/workflows/` reported for a maintainer to apply
- out-of-scope problems it is certain of but cannot fix with certainty opened as issues
- routine PRs it is certain about merged the way the repository merged similar ones, if the head still matches the reviewed commit
- one Codex session per PR, resumed on every push
- awareness of the repository's CI, waiting for workflows that push fixes such as formatting

During a PR review, `bash "$GITHUB_ACTION_PATH/scripts/review-threads.sh" list` prints a JSON array of threads with their locations, resolution state and first comments. Use `lookup <REST comment id>` to get the thread ID for a comment or reply. The same helper accepts `resolve <threadId> [--reply <body>]` and `unresolve <threadId>` for the current PR.

## Setup

1. [Install the App](https://github.com/apps/muspi-merol-review/installations/new) on the repository.
2. Save a Codex `config.toml` as the `CODEX_CONFIG` secret. Its model provider must speak the Responses API:

   ```toml
   model = "gpt-6.1-sol"
   model_provider = "example"

   [model_providers.example]
   name = "Example"
   base_url = "https://api.example.com/v1"
   wire_api = "responses"
   experimental_bearer_token = "sk-..."
   ```

   ```sh
   gh secret set CODEX_CONFIG < config.toml
   ```

3. To review on a ChatGPT plan instead of a provider key, log in on any machine with a browser and save the credentials:

   ```sh
   codex login --device-auth
   # Keep it on one line: the runner masks every line of a multi-line secret, so a lone "{" or "}" redacts every brace in the logs.
   jq -c . ~/.codex/auth.json | gh secret set CODEX_AUTH
   ```

4. Add `.github/workflows/agent.yml`:

   ```yaml
   name: agent invoke
   on:
     pull_request_target:
       types: [opened, synchronize, reopened, ready_for_review, edited]
     # Comments and reviews that start a review when none is running.
     issue_comment:
       types: [created, edited, deleted]
     pull_request_review:
       types: [submitted, edited, dismissed]
     pull_request_review_comment:
       types: [created, edited, deleted]

   permissions:
     actions: read
     id-token: write

   jobs:
     agent:
       uses: promplate/code-review/.github/workflows/review.yml@main
       with:
         # Only repository writers may wake the agent, checked before the run joins the review queue.
         authorize: true
       secrets:
         codex-config: ${{ secrets.CODEX_CONFIG }}
         codex-auth: ${{ secrets.CODEX_AUTH }}
   ```

In a public repository, an Actions event policy must allow the `pull_request_target` trigger: from December 2, 2026 GitHub's default policy will block it ([changelog](https://github.blog/changelog/2026-11-02-pull_request_target-blocked-by-default-december-2/)). Allow it explicitly — Settings → Actions → Policies, an event policy whose allowed events include `pull_request_target`, `issue_comment`, `pull_request_review`, and `pull_request_review_comment` (plus any other trigger the workflow enables), scoped to this workflow file ([docs](https://docs.github.com/en/actions/how-tos/administer/control-workflow-execution)) — or reviews stop starting on pull request events while comment triggers keep working, each blocked run failing as a `startup_failure` with no jobs and an annotation that blames the workflow file. Private and internal repositories are unaffected.

The same policy through the REST API, which is what new repositories copy; `allowed_events` is a whitelist rather than a list of exceptions, so it names every trigger the workflow keeps, plus the optional ones below, so enabling one later does not trip the policy ([endpoints](https://docs.github.com/en/rest/actions/policies)):

```sh
gh api -X POST repos/OWNER/REPO/actions/policies -H 'X-GitHub-Api-Version: 2026-03-10' --input - <<'JSON'
{
  "name": "allow `pull_request_target` for agent invoke",
  "enforcement": "active",
  "conditions": { "workflow_path": { "include": [".github/workflows/agent.yml"], "exclude": [] } },
  "rules": [{ "type": "restrict_action_events", "parameters": { "allowed_events": ["pull_request_target", "issues", "issue_comment", "pull_request_review", "pull_request_review_comment", "push", "repository_dispatch", "workflow_dispatch"] } }]
}
JSON
```

The reusable workflow owns the permission check, the shared concurrency group and the review step. Pass `authorize: false` only when every trigger is trusted, such as a private repository; without the check, an unauthorized run still takes a queue slot before it exits. `service-tier` and `session-key` reach the action through the same call. `setup` runs shell on the runner before Codex is installed, for tools the review needs; add their directories to the PATH through `$GITHUB_PATH`. `instructions` appends repository rules to the prompt, after the built-in review instructions. Codex takes its config, its ChatGPT credentials and an optional model catalog, and each is either passed as contents or named as a file in this repository: `codex-config-file`, `codex-auth-file` and `model-catalog-file`. A file is read from the default branch rather than the change under review, since these settings shape how Codex runs, and contents win when both are given. The catalog input also takes precedence over a `model_catalog_json` the config names itself.

A catalog that only the change under review has, such as one a pull request introduces, warns and continues without the override, leaving any `model_catalog_json` in the supplied config intact. A path that neither the default branch nor that change has fails the run. Fetches retry recognized network errors, 5xx responses, bare 429s, and responses whose message identifies a secondary rate limit or abuse detection; primary rate limits and other failures stop immediately. Secondary limits start with a one-minute wait and back off to five minutes, within the same eight-attempt limit.

When the supplied config omits `project_doc_fallback_filenames`, the action imports only that key from the default branch's `.codex/config.toml`. It accepts an array of plain filenames, such as `["CLAUDE.md"]`; invalid TOML or filenames warn and are ignored. An explicit setting, including `[]`, wins. The reviewed checkout supplies the instruction files themselves, as it does for `AGENTS.md`, but cannot change this list or enable other configuration.

Comments and reviews wake a new review by starting a workflow run themselves, through the workflow's own triggers. They start runs only when the workflow exists on the **default branch** ([docs](https://docs.github.com/en/actions/reference/events-that-trigger-workflows#issue_comment)), so a workflow added on a PR branch can review that PR but cannot take comments until it reaches the default branch.

Every run sharing a session must use the same serialized concurrency group.

Each run seeds the webhook that started it into its event stream in the same shape the broker relays. Hooks dedupe by activity identity; repeatable check and thread transitions use the broker's webhook delivery identity instead. A run started for a comment another run already handled is skipped, and changes between runs are reconciled by reading current GitHub state:

- Only people with write access and other apps' review activity can steer a review; other apps' ordinary comments are ignored, as are the App's own.
- Editing a pull request's title or description starts a review of the new text, and a running review receives it through the same stream.
- All authorized triggers for a PR share one concurrency group. `queue: max` preserves up to 100 pending runs while the active review consumes SSE updates; unauthorized discussion events never take a queue slot, so they cannot cancel a new head's review. A run still authorizing or waiting for the group has consumed no head, so it does not make a newer run skip.
- While a review runs, its SSE subscription takes the comments live; a synchronous tool hook records them before the model's next message, and a blocked stop catches whatever arrives after the last tool call.
- Completed checks on the reviewed head wake a review that waits for CI; the review's own check runs and suites never do.
- The review decides when a pull request is safe to merge, using CI results it trusts and running the checks that matter when CI is missing or flaky. It leaves work that is still moving, such as recent pushes or an open draft, to the author. The action merges only when the verdict says so and the head has not moved since.

The tool and stop hooks record consumed context locally. The action checkpoints these receipts with the review session after publishing the checks, PR review and reactions successfully. Session snapshots are Actions artifacts shared across trigger refs and subject to the repository's artifact retention. When no artifact exists, the action can resume from a legacy cache visible to the trigger. Queued runs fetch the current PR head and skip consumed activity only when that head also has a saved publication checkpoint. Receiving an event alone never marks it consumed, and a forked review starts its own checkpoint. Receipt deduplication is independent of the transport: the action neither saves a replay cursor nor sends `Last-Event-ID`.

Anyone with read access to the repository can download its session artifacts, including the full Codex conversation and tool output. In a public repository, treat those snapshots as public. [GitHub artifact access](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts)

The broker must return HTTP 200 with `Content-Type: text/event-stream`. The subscription holds one connection open until it ends, then retries with jittered backoff up to 30 seconds; an HTML error page, a minute without a ping, or a timeout before response headers cannot count as a healthy stream. Stopping the subscription also stops its curl, parser and retry timer.

Each run reads current state from GitHub. A disconnect (including a clean EOF) or a stopped subscriber sends `subscription_recovery` context, and a successful reconnect requests another read to cover the whole outage. The review reconciles current state, CI and discussion through GitHub, checking commenters' write access before following instructions. This does not reconstruct deleted comments or transient CI states, and the notification does not prove the model completed those reads. Events missed while disconnected have no replay guarantee. A crash after writing context can repeat it, and a thread-triggered run can see both its trigger and broker copy; delivery is not exactly once.

A head pushed after Codex exits is handled by a subsequent workflow run. Publication checks the current PR head and warns when the verdict omits it. Pushes that start no workflow still need an external wake-up trigger to guarantee a follow-up review.

Add `repository_dispatch: { types: [code-review] }` to also let the broker start a review when a base push leaves an approved PR conflicting. The dispatch identifies the PR in `client_payload.pr`.

Add `workflow_dispatch` to start a run by hand, and give it `pr` and `issue` inputs to name the target; with neither, it reviews the ref it was dispatched on. A pull request belongs in `pr`, because sessions are grouped by the number they act on: an `issue` input rejects a number the API reports as a pull request rather than running in that PR's group.

## Pushes

To also review pushes outside PRs, such as direct commits to `main`, add a `push` trigger. The reusable workflow keys the concurrency group by ref for pushes:

```yaml
on:
  push:
    branches: [main]
  pull_request_target:
    types: [opened, synchronize, reopened, ready_for_review]
```

A push gets a `code-review` check run on its head commit. Certain fixes are committed to the branch, or opened as PRs when branch protection rejects them, and Codex comments on a commit only when someone has to act. Each branch keeps one session; set the `session-key` input to group reviews differently. A push that lands only trees this session already reviewed as PR heads, as a squash or rebase merge does, is skipped: its head repeats that verdict as its own check run and only advances the session's reviewed head.

Set the `service-tier` input to `ultrafast` (or another tier the model advertises) to have the provider run reviews on its fastest queue; it is opt-in, so evaluation runs and cost-sensitive consumers keep the provider default.

## Issues

Add an `issues` trigger to have issue activity start a session that acts on issues instead of reviewing them:

```yaml
on:
  issues:
```

A plain issue is not a review: the agent works on the default branch, keeps one session per issue, and decides for itself whether to check the claim, answer in the thread, open a PR, or leave it alone; labelling and classifying the issue is its work too, so the trigger delivers every issue event rather than filtering out the ones a run might act on. Such a run posts no check run and no verdict. Only issues from users with write access start a session: anyone else's activity still runs the authorization step, which skips the review job, and a closed issue has nothing left to answer, so its events are skipped too.

## Runtime

The action reuses `bun-version` from the runner or installs it, and uses Bun for the Codex launcher and the optional Langfuse hook. An existing `codex` binary is reused; otherwise Bun installs `codex-version`, or the latest release when it is empty, inside the job's temp directory. The reviewer's `gh` MCP server runs as `uvx gh-mcp`, so the action installs uv only when the runner has none and keeps uv's cache, tools and any Python it downloads under that same directory. The review prompt receives the installed versions rather than hard-coded versions. No separate Node.js installation is needed. Codex 0.169.0 skips an untrusted checkout's own `.codex/config.toml`, so a pull request cannot run the MCP servers it names, and its other executable settings stay disabled. Documentation fallback names come from the supplied config or the default branch as described above. Reusing an older binary does not apply this upgrade. The SSE subscriber requires Bash 5.1 or newer to monitor curl and its parser together. GitHub's checkout, cache and artifact actions use their own Node 24 runtime; self-hosted runners must be version 2.327.1 or newer. This repository calls its own action and workflow with `$/`, which needs github.com and runner 2.336.0 or newer and follows whatever ref the calling workflow runs at; a consumer still references them as `promplate/code-review@<ref>`.

## Options

The App needs **Contents**, **Pull requests**, **Checks** and **Issues** write access for PR reviews. **Issues** write is required for the [PR-body and issue-comment reactions](https://docs.github.com/en/rest/reactions/reactions#create-reaction-for-an-issue), as well as opening issues for problems the reviewer cannot fix. The broker asks for whichever Issues level the installation grants, but Issues read-only cannot create issues or add and remove those reactions. There is no mode that skips reactions: a denied PR-body eyes reaction fails “Mark PR as reviewing” before Codex starts, and final verdict reactions also require write access.

PR conversation comments use the issue-comment endpoints, but [creating, editing and deleting them](https://docs.github.com/en/rest/issues/comments) also accept **Pull requests** write, which the App already requires. Issues read-only therefore does not itself prevent those PR comment operations; it still cannot support the complete PR review flow above.

`id-token: write` lets the job prove which repository it runs in, in exchange for an App token limited to that repository and without the `workflows` permission. Fixes touching `.github/workflows/` are report-only in both review and issue sessions: Codex describes the required changes for a maintainer to apply, including any dependent changes in other files. `actions: read` lets the job restore session artifacts and look up workflow runs. Grant the App **Actions** write access to let the broker prune superseded snapshots. The broker keeps that credential server-side, and without it the snapshots expire according to the repository's retention policy.

To review as your own GitHub App, deploy the broker with that App's credentials and set `with.broker` on the action or reusable workflow to its HTTPS origin, such as `https://review-broker.example.com`. Both default to `https://cf-webhook-sse-poc.admin-c9f.workers.dev`. The action learns which login it acts as from the token it mints, so workflows never name the App.

A broker may return `{ "skip": true }` from its token endpoint to skip this invocation. The action sends `X-Review-Target: pull_request` for PR work and `other` for issue or branch work, so a broker can route those independently. An ordinary token response follows the existing review flow. Routing and any external execution service belong to the broker; the action needs only its broker URL.

Choose a broker operator you trust: the job sends it a GitHub OIDC token with the broker URL as its audience, and trusts its installation token and event stream. The current broker does not provide snapshot encryption keys; session and debug artifacts remain unencrypted. Broker-managed encryption would protect downloaded artifacts from repository readers, not from the broker operator or the authorized runner.

Set `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` and `LANGFUSE_BASE_URL` in the job's `env` to trace reviews to Langfuse with [langfuse/codex-observability-plugin](https://github.com/langfuse/codex-observability-plugin "Langfuse observability plugin for Codex").

`login/` serves the same device login in a browser, for whoever cannot install Codex themselves: `bun login/index.ts`, open the page, and copy the returned `auth.json` into the secret.

## Hosted execution

`scripts/hosted-review.sh` runs the same configuration, Codex invocation, live-event hooks, publication and merge helpers that the action calls. It runs inside a prepared Linux environment, with Bash 5.1+, Bun, Codex, uv, gh, git, jq, curl and file. The hosting service owns authorization, a serialized queue per repository/session, installation-token renewal, sandbox cleanup and durable session storage.

Run it from a full checkout of the scheduled PR head with the default branch fetched under `refs/remotes/origin/`. Supply these environment variables:

- `GITHUB_ACTION_PATH`: an absolute path to this repository at a pinned revision.
- `GITHUB_REPOSITORY`, `PR_NUMBER`, `HEAD_SHA`, `BOT_LOGIN`: the authorized repository, pull request, scheduled commit and GitHub App login.
- `CODEX_HOME`, `RUNNER_TEMP`, `GH_CONFIG_DIR`: isolated absolute paths for the session, this attempt and the repository-scoped `gh` credential.
- `GITHUB_EVENT_PATH`, `EVENT_NAME`, `ACTIVITY_ID`, `ACTIVITY_WRITER`: the verified webhook body, event name, stable delivery identity and permission result.
- `CODEX_CONFIG_FILE`, `CODEX_AUTH_FILE`: trusted configuration and credentials, unless supplied directly through `CODEX_CONFIG` and `CODEX_AUTH`.
- `DETAILS_URL`: the authenticated run page linked from the review check. `EVENTS_URL` supplies live SSE updates in the broker's existing format.

Optional `CHECK_ID` reuses a check owned by the hosting service. `REVIEW_RUN_ID` and `REVIEW_RUN_ATTEMPT` identify an attempt for subscription recovery. `DEFAULT_BRANCH`, `SERVICE_TIER`, `EXTRA_INSTRUCTIONS`, `CATALOG` and `MODEL_CATALOG` use the same meanings as the action. To fork an opening review's conversation, restore its state into `$CODEX_HOME/fork` and set `FORK_KEY` to its session key.

To index the combined process log, redirect stdout and stderr to the same file with `> "$REVIEW_OUTPUT_LOG" 2>&1` and set `REVIEW_STEP_INDEX` to a fresh file path for the attempt. Export both paths. As each step starts, the entry appends a line of the form `<step> <byte-offset>` to the index. The offset points to the start of that step's output in the raw log.

The entry writes `$RUNNER_TEMP/result.json` with `status` (`completed`, `superseded`, `skipped` or `failed`), `headSha`, `currentHead`, `checkId` and `published`. A superseded result tells the scheduler which head needs another run. It never treats receiving an event as a completed publication. Persist `sessions/`, `last-thread-id` and `check-runs.jsonl` from `CODEX_HOME`, and save any refreshed `auth.json` back to the encrypted credential store. Auth belongs to the repository credential store, separately from conversation snapshots.

After persisting a successful publication, call `scripts/finish-hosted-review.sh` with the same environment to mark any fix PRs ready and perform an approved merge. Save the updated pending-draft list afterward. This ordering lets the child review restore its opening conversation before it starts and keeps the merged review's session durable. Stop the sandbox in a `finally` block, including after command failure, and inspect the command's exit code.
