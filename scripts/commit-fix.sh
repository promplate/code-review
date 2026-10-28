#!/usr/bin/env bash
# Commit working-tree changes via createCommitOnBranch so GitHub signs them as the App (Verified); git push would leave them unsigned.
set -eo pipefail
git add -A
additions=$(git diff --cached --no-renames --diff-filter=AM --name-only | while read -r path; do
  jq -n --arg path "$path" --arg contents "$(base64 < "$path" | tr -d '\n')" '{path: $path, contents: $contents}'
done | jq -s .)
deletions=$(git diff --cached --no-renames --diff-filter=D --name-only | jq -R '{path: .}' | jq -s .)
jq -n --arg repo "$GITHUB_REPOSITORY" --arg branch "$HEAD_BRANCH" --arg head "$(git rev-parse HEAD)" --arg headline "$1" --argjson additions "$additions" --argjson deletions "$deletions" '{
  query: "mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } } }",
  variables: {input: {branch: {repositoryNameWithOwner: $repo, branchName: $branch}, expectedHeadOid: $head, message: {headline: $headline}, fileChanges: {additions: $additions, deletions: $deletions}}}
}' | bash "$GITHUB_ACTION_PATH/scripts/retry.sh" gh api graphql --input - --jq .data.createCommitOnBranch.commit.oid
bash "$GITHUB_ACTION_PATH/scripts/retry.sh" git fetch -q origin "$HEAD_BRANCH" < /dev/null
git reset -q --hard FETCH_HEAD
