#!/usr/bin/env bash
# Exchanges this job's OIDC token for the broker's, so both token minting and snapshot pruning authenticate the same way.
set -euo pipefail
: "${ACTIONS_ID_TOKEN_REQUEST_URL:?Grant the job id-token: write so it can authenticate as the App.}"
curl -fsS --retry 5 -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=$1" | jq -er .value
