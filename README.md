# Codex Code Review

Reviews same-repository pull requests with [Codex](https://github.com/openai/codex "openai/codex") as the [muspi-merol-review](https://github.com/apps/muspi-merol-review "muspi-merol-review GitHub App") GitHub App:

- a `codex-review` check run per commit, with annotations
- `REQUEST_CHANGES` with inline threads for must-fix issues only, `APPROVE` otherwise
- everything else as regular PR comments, including answers to PR comments
- certain fixes committed to the PR, or opened as separate PRs when out of scope
- routine PRs it is certain about merged the way the repository merged similar ones, once every other check passes
- one Codex session per PR, resumed on every push

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

3. Add `.github/workflows/codex-review.yml`:

   ```yaml
   name: codex-review
   on:
     pull_request_target:
       types: [opened, synchronize, reopened, ready_for_review]
     # Comments posted while no review is running.
     repository_dispatch:
       types: [codex-review]

   permissions:
     actions: write
     id-token: write

   concurrency:
     group: codex-review-${{ github.event.pull_request.number || github.event.client_payload.pr }}

   jobs:
     review:
       # Sessions are cached in the base branch's scope, so only same-repository PRs are reviewed; the App's own PRs wait until they leave draft.
       if: github.event_name == 'repository_dispatch' || github.event.pull_request.head.repo.full_name == github.repository && (github.event.pull_request.user.login == 'muspi-merol-review[bot]' && !github.event.pull_request.draft || github.event.pull_request.user.login != 'muspi-merol-review[bot]' && github.event.action != 'ready_for_review')
       cache-mode: write
       runs-on: ubuntu-latest
       steps:
         - uses: promplate/code-review@v1
           with:
             codex-config: ${{ secrets.CODEX_CONFIG }}
   ```

`id-token: write` lets the job prove which repository it runs in, in exchange for an App token limited to that repository and without the `workflows` permission. `actions: write` lets it drop superseded session snapshots from the Actions cache.

Set `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` and `LANGFUSE_BASE_URL` in the job's `env` to trace reviews to Langfuse with [langfuse/codex-observability-plugin](https://github.com/langfuse/codex-observability-plugin "Langfuse observability plugin for Codex").
