#!/usr/bin/env bash
# Bun reads a bunfig.toml from the working directory, and the checkout under review is untrusted.
cd "$RUNNER_TEMP" || exit 1
exec bun "$GITHUB_ACTION_PATH/scripts/snapshot.ts" "$@"
