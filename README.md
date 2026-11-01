# Codex Code Review

Reviews same-repository pull requests, and optionally branch pushes, with [Codex](https://github.com/openai/codex "openai/codex") as the [muspi-merol-review](https://github.com/apps/muspi-merol-review "muspi-merol-review GitHub App") GitHub App:

- a `code-review` check run per commit, with annotations on the reviewed head
- `REQUEST_CHANGES` with inline threads for must-fix issues only, `APPROVE` otherwise
- everything else as regular PR comments, including answers to PR comments
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
   gh secret set CODEX_AUTH < ~/.codex/auth.json
   ```

4. Add `.github/workflows/code-review.yml`:

   ```yaml
   name: code-review
   on:
     pull_request_target:
       types: [opened, synchronize, reopened, ready_for_review]
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

   concurrency:
     # Comments and reviews from bots cannot steer a review, yet their runs would evict a review that waits for a runner when queued after it.
     group: code-review-${{ github.event.pull_request.number || github.event.issue.number || github.event.client_payload.pr }}${{ endsWith(github.event.sender.login, '[bot]') && github.event_name != 'pull_request_target' && github.event_name != 'repository_dispatch' && format('-{0}', github.run_id) || '' }}

   jobs:
     review:
       # Sessions are cached in the base branch's scope, so only same-repository PRs are reviewed; the App's own PRs wait until they leave draft.
       if: >
         (github.event_name == 'issue_comment' && github.event.issue.pull_request != null && github.event.issue.state == 'open')
         || (github.event_name != 'issue_comment' && github.event.pull_request.state == 'open' && github.event.pull_request.head.repo.full_name == github.repository
             && (github.event.pull_request.user.login == 'muspi-merol-review[bot]' && !github.event.pull_request.draft
                 || github.event.pull_request.user.login != 'muspi-merol-review[bot]' && github.event.action != 'ready_for_review'))
       cache-mode: write
       runs-on: ubuntu-latest
       steps:
         - uses: promplate/code-review@v1
           with:
             codex-config: ${{ secrets.CODEX_CONFIG }}
             codex-auth: ${{ secrets.CODEX_AUTH }}
   ```

Comments and reviews wake a new review by starting a workflow run themselves, through the workflow's own triggers. They start runs only when the workflow exists on the **default branch** ([docs](https://docs.github.com/en/actions/reference/events-that-trigger-workflows#issue_comment)), so a workflow added on a PR branch can review that PR but cannot take comments until it reaches the default branch.

Each run seeds the webhook that started it into its event stream in the same shape the broker relays, so the review hooks read one stream and dedupe by an id derived from the webhook body. A run started for a comment another run already handled is skipped, and comments posted between runs are replayed from the last consumed event:

- Only people with write access can steer a review, and the App's own comments are ignored.
- A run started by the App's own comment or review skips, and sits in its own concurrency group, so it can never cancel a review that is waiting for a runner.
- While a review runs, its SSE subscription takes the comments live.
- Completed checks on the reviewed head wake a review that waits for CI; the review's own check runs and suites never do.

Add `repository_dispatch: { types: [code-review] }` to also let the broker start a review when a base push leaves an approved PR conflicting.

## Pushes

To also review pushes outside PRs, such as direct commits to `main`, add a `push` trigger, key the concurrency group by ref for pushes, and let pushes pass the job's `if:`:

```yaml
on:
  push:
    branches: [main]
  pull_request_target:
    types: [opened, synchronize, reopened, ready_for_review]

concurrency:
  group: code-review-${{ github.event.pull_request.number || github.event.client_payload.pr || github.ref }}

jobs:
  review:
    if: github.event_name != 'pull_request_target' || github.event.pull_request.head.repo.full_name == github.repository && (...)
```

A push gets a `code-review` check run on its head commit. Certain fixes are committed to the branch, or opened as PRs when branch protection rejects them, and Codex comments on a commit only when someone has to act. Each branch keeps one session; set the `session-key` input to group reviews differently.

## Runtime

The action reuses `bun-version` from the runner or installs it, and uses Bun for the Codex launcher and the optional Langfuse hook. An existing `codex` binary is reused; otherwise Bun installs `codex-version`. The review prompt receives the installed versions rather than hard-coded versions. No separate Node.js installation is needed. GitHub's checkout, cache and artifact actions use their own Node 24 runtime; self-hosted runners must be version 2.327.1 or newer.

## Options

The App needs **Contents**, **Pull requests** and **Checks** write access, plus **Issues** write when reviews should open issues for problems they cannot fix. The broker asks for whichever Issues level the installation grants, so a read-only installation still reviews and only loses issue creation.

`id-token: write` lets the job prove which repository it runs in, in exchange for an App token limited to that repository and without the `workflows` permission. `actions: write` lets it drop superseded session snapshots from the Actions cache.

To review as your own GitHub App, deploy the broker with that App's credentials, point the `broker` input at it, and use the App's bot login in the job's `if:`.

Set `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` and `LANGFUSE_BASE_URL` in the job's `env` to trace reviews to Langfuse with [langfuse/codex-observability-plugin](https://github.com/langfuse/codex-observability-plugin "Langfuse observability plugin for Codex").

`login/` serves the same device login in a browser, for whoever cannot install Codex themselves: `bun login/index.ts`, open the page, and copy the returned `auth.json` into the secret.
