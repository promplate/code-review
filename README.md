# Codex Code Review

Reviews same-repository pull requests, and optionally branch pushes, with [Codex](https://github.com/openai/codex "openai/codex") as the [muspi-merol-review](https://github.com/apps/muspi-merol-review "muspi-merol-review GitHub App") GitHub App:

- a `code-review` check run per commit, with annotations on the reviewed head
- `REQUEST_CHANGES` with inline threads for must-fix issues only, `APPROVE` otherwise; a finding an unresolved thread already carries is not posted again
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
     agent:
       uses: promplate/code-review/.github/workflows/review.yml@main
       with:
         # Only repository writers may wake the agent, checked before the run joins the review queue.
         authorize: true
       secrets:
         codex-config: ${{ secrets.CODEX_CONFIG }}
         codex-auth: ${{ secrets.CODEX_AUTH }}
   ```

The reusable workflow owns the permission check, the shared concurrency group and the review step. Pass `authorize: false` only when every trigger is trusted, such as a private repository; without the check, an unauthorized run still takes a queue slot before it exits. `service-tier` and `session-key` reach the action through the same call. `setup` runs shell on the runner before Codex is installed, for tools the review needs; add their directories to the PATH through `$GITHUB_PATH`. `model-catalog-file` names a Codex model catalog in this repository, which is read from the default branch rather than the change under review and takes precedence over a `model_catalog_json` the config names itself.

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

The action reuses `bun-version` from the runner or installs it, and uses Bun for the Codex launcher and the optional Langfuse hook. An existing `codex` binary is reused; otherwise Bun installs `codex-version`. The review prompt receives the installed versions rather than hard-coded versions. No separate Node.js installation is needed. Codex 0.169.0 skips an untrusted checkout's own `.codex/config.toml`, so a pull request cannot run the MCP servers it names, and the documentation fallbacks it sets, such as `project_doc_fallback_filenames`, do not apply either; a repository that needs either puts it in `codex-config` instead. Reusing an older binary does not apply this upgrade. The SSE subscriber requires Bash 5.1 or newer to monitor curl and its parser together. GitHub's checkout, cache and artifact actions use their own Node 24 runtime; self-hosted runners must be version 2.327.1 or newer. This repository calls its own action and workflow with `$/`, which needs github.com and runner 2.336.0 or newer and follows whatever ref the calling workflow runs at; a consumer still references them as `promplate/code-review@<ref>`.

## Options

The App needs **Contents**, **Pull requests** and **Checks** write access, plus **Issues** write when reviews should open issues for problems they cannot fix. The broker asks for whichever Issues level the installation grants, so a read-only installation still reviews and only loses issue creation.

`id-token: write` lets the job prove which repository it runs in, in exchange for an App token limited to that repository and without the `workflows` permission. `actions: write` lets it restore session artifacts across workflow runs and drop superseded snapshots.

To review as your own GitHub App, deploy the broker with that App's credentials and point the `broker` input at it; the action learns which login it acts as from the token it mints, so workflows never name the App.

Set `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` and `LANGFUSE_BASE_URL` in the job's `env` to trace reviews to Langfuse with [langfuse/codex-observability-plugin](https://github.com/langfuse/codex-observability-plugin "Langfuse observability plugin for Codex").

`login/` serves the same device login in a browser, for whoever cannot install Codex themselves: `bun login/index.ts`, open the page, and copy the returned `auth.json` into the secret.
