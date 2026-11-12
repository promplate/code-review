# Codex Code Review

Reviews same-repository pull requests, and optionally branch pushes, with [Codex](https://github.com/openai/codex "openai/codex") as the [muspi-merol-review](https://github.com/apps/muspi-merol-review "muspi-merol-review GitHub App") GitHub App:

- a `code-review` check run per commit, with annotations on the reviewed head
- `REQUEST_CHANGES` with inline threads for must-fix issues only, `APPROVE` otherwise
- everything else as regular PR comments, answers to review comments in their thread
- certain fixes committed to the PR, or opened as separate PRs when out of scope
- out-of-scope problems it is certain of but cannot fix with certainty opened as issues
- routine PRs it is certain about merged the way the repository merged similar ones, once every other check passes
- one Codex session per PR, resumed on every push
- awareness of the repository's CI, waiting for workflows that push fixes such as formatting

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
     actions: write
     id-token: write

   jobs:
     authorize:
       # The review group holds 100 pending runs and cancels the next one, so a stream of comments the action
       # would skip must never take a slot there: it could push a new head's review out of the queue.
       # The lookup needs only repository metadata, which every job token may read, so this job holds no scopes.
       name: Check ${{ github.event.sender.login }} may steer the agent
       permissions: {}
       uses: promplate/code-review/.github/workflows/authorize.yml@main
       with:
         runs-on: ubuntu-latest
     review:
       # Sessions are cached in the base branch's scope, so only same-repository PRs are reviewed; the App's own PRs wait until they leave draft.
       needs: authorize
       if: >
         needs.authorize.outputs.writer == 'true' && (
         (github.event.issue.pull_request != null && github.event.issue.state == 'open')
         || (github.event_name == 'repository_dispatch' && github.event.client_payload.pr)
         || (github.event.issue.pull_request == null && github.event.pull_request.state == 'open' && github.event.pull_request.head.repo.full_name == github.repository
             && (github.event.action != 'ready_for_review' || github.event.pull_request.user.type == 'Bot')))
       concurrency:
         # Keep the active review consuming SSE while later events wait to reconcile its saved session.
         group: code-review-${{ github.event.pull_request.number || github.event.issue.number || github.event.client_payload.pr }}
         queue: max
       # Low-trust events such as pull_request_target and issue_comment cannot save caches by default, which would drop every session snapshot.
       cache-mode: write
       runs-on: ubuntu-latest
       steps:
         - uses: promplate/code-review@main
           with:
             codex-config: ${{ secrets.CODEX_CONFIG }}
             codex-auth: ${{ secrets.CODEX_AUTH }}
   ```

Comments and reviews wake a new review by starting a workflow run themselves, through the workflow's own triggers. They start runs only when the workflow exists on the **default branch** ([docs](https://docs.github.com/en/actions/reference/events-that-trigger-workflows#issue_comment)), so a workflow added on a PR branch can review that PR but cannot take comments until it reaches the default branch.

Every run sharing a session must use the same serialized concurrency group.

Each run seeds the webhook that started it into its event stream in the same shape the broker relays. Hooks dedupe by activity identity; repeatable check and thread transitions use the broker's webhook delivery identity instead. A run started for a comment another run already handled is skipped, and changes between runs are reconciled by reading current GitHub state:

- Only people with write access and other apps' review activity can steer a review; other apps' ordinary comments are ignored, as are the App's own.
- Editing a pull request's title or description starts a review of the new text, and a running review receives it through the same stream.
- All authorized triggers for a PR share one concurrency group. `queue: max` preserves up to 100 pending runs while the active review consumes SSE updates; unauthorized discussion events never take a queue slot, so they cannot cancel a new head's review. A run still authorizing or waiting for the group has consumed no head, so it does not make a newer run skip.
- While a review runs, its SSE subscription takes the comments live; a synchronous tool hook records them before the model's next message, and a blocked stop catches whatever arrives after the last tool call.
- Completed checks on the reviewed head wake a review that waits for CI; the review's own check runs and suites never do.
- Before merging, the review waits for the head's checks except its own and those of other runs of this workflow, whose queued jobs could never finish behind the waiting job. That lookup needs `actions: read` on the job token; without it the wait falls back to every check.

The tool and stop hooks record consumed context locally. The action checkpoints these receipts with the review session after publishing the checks, PR review and reactions successfully. Queued runs fetch the current PR head and skip consumed activity only when that head also has a saved publication checkpoint. Older caches without this checkpoint are reviewed once more. Receiving an event alone never marks it consumed, and a forked review starts its own checkpoint. Receipt deduplication is independent of the transport: the action neither saves a replay cursor nor sends `Last-Event-ID`.

The broker must return HTTP 200 with `Content-Type: text/event-stream`. The subscription holds one connection open until it ends, then retries with jittered backoff up to 30 seconds; an HTML error page, a minute without a ping, or a timeout before response headers cannot count as a healthy stream. Stopping the subscription also stops its curl, parser and retry timer.

Each run reads current state from GitHub. A disconnect (including a clean EOF) or a stopped subscriber sends `subscription_recovery` context, and a successful reconnect requests another read to cover the whole outage. The review reconciles current state, CI and discussion through GitHub, checking commenters' write access before following instructions. This does not reconstruct deleted comments or transient CI states, and the notification does not prove the model completed those reads. Events missed while disconnected have no replay guarantee. A crash after writing context can repeat it, and a thread-triggered run can see both its trigger and broker copy; delivery is not exactly once.

A head pushed after Codex exits is handled by a subsequent workflow run. Publication checks the current PR head and warns when the verdict omits it. Pushes that start no workflow still need an external wake-up trigger to guarantee a follow-up review.

Add `repository_dispatch: { types: [code-review] }` to also let the broker start a review when a base push leaves an approved PR conflicting. The dispatch identifies the PR in `client_payload.pr`.

## Pushes

To also review pushes outside PRs, such as direct commits to `main`, add a `push` trigger, key the concurrency group by ref for pushes, and let pushes pass the job's `if:`:

```yaml
on:
  push:
    branches: [main]
  pull_request_target:
    types: [opened, synchronize, reopened, ready_for_review]

jobs:
  review:
    if: github.event_name != 'pull_request_target' || github.event.pull_request.head.repo.full_name == github.repository && (...)
    concurrency:
      group: code-review-${{ github.event.pull_request.number || github.event.client_payload.pr || github.ref }}
      queue: max
    cache-mode: write
```

`on.push.branches` cannot name a repository's current default branch, which may not be `main`. To review whatever the default branch is, trigger on every push and filter in the job instead. Each push to another branch then starts a run whose `authorize` job finishes in seconds and skips the review, while the default branch proceeds:

```yaml
on:
  push:

jobs:
  review:
    if: needs.authorize.outputs.writer == 'true' && (github.event_name != 'push' || github.ref_name == github.event.repository.default_branch)
```

A push gets a `code-review` check run on its head commit. Certain fixes are committed to the branch, or opened as PRs when branch protection rejects them, and Codex comments on a commit only when someone has to act. Each branch keeps one session; set the `session-key` input to group reviews differently. A push that lands only trees this session already reviewed as PR heads, as a squash or rebase merge does, is skipped: its head repeats that verdict as its own check run and only advances the session's reviewed head.

Set the `service-tier` input to `ultrafast` (or another tier the model advertises) to have the provider run reviews on its fastest queue; it is opt-in, so evaluation runs and cost-sensitive consumers keep the provider default.

## Issues

Add an `issues` trigger, and let plain-issue activity pass the job's `if:`, to have the same session act on issues instead of reviewing them:

```yaml
on:
  issues:
    types: [labeled]

jobs:
  review:
    if: github.event.issue.state == 'open' || github.event.pull_request.state == 'open' && (...)
```

A plain issue is not a review: the agent works on the default branch, keeps one session per issue, and decides for itself whether to check the claim, answer in the thread, open a PR, or leave it alone. Such a run posts no check run and no verdict; the trigger only delivers the context. `labeled` rather than `opened` keeps every new issue from waking it before someone asks.

## Runtime

The action reuses `bun-version` from the runner or installs it, and uses Bun for the Codex launcher and the optional Langfuse hook. An existing `codex` binary is reused; otherwise Bun installs `codex-version`. The review prompt receives the installed versions rather than hard-coded versions. No separate Node.js installation is needed. The SSE subscriber requires Bash 5.1 or newer to monitor curl and its parser together. GitHub's checkout, cache and artifact actions use their own Node 24 runtime; self-hosted runners must be version 2.327.1 or newer.

## Options

The App needs **Contents**, **Pull requests** and **Checks** write access, plus **Issues** write when reviews should open issues for problems they cannot fix. The broker asks for whichever Issues level the installation grants, so a read-only installation still reviews and only loses issue creation.

`id-token: write` lets the job prove which repository it runs in, in exchange for an App token limited to that repository and without the `workflows` permission. `actions: write` lets it drop superseded session snapshots from the Actions cache.

To review as your own GitHub App, deploy the broker with that App's credentials and point the `broker` input at it; the action learns which login it acts as from the token it mints, so workflows never name the App.

Set `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` and `LANGFUSE_BASE_URL` in the job's `env` to trace reviews to Langfuse with [langfuse/codex-observability-plugin](https://github.com/langfuse/codex-observability-plugin "Langfuse observability plugin for Codex").

`login/` serves the same device login in a browser, for whoever cannot install Codex themselves: `bun login/index.ts`, open the page, and copy the returned `auth.json` into the secret.
