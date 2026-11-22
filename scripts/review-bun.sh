#!/usr/bin/env bash
# Keep the review cwd for Git and Codex without loading the checkout's bunfig.toml.
exec bun --config="$GITHUB_ACTION_PATH/scripts/review-bun.toml" "$@"
