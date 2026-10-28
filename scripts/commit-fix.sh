#!/usr/bin/env bash
# Commit working-tree changes through the Git database API so GitHub signs them as the App (Verified); git push would leave them unsigned. An unfinished git merge becomes a merge commit.
set -eo pipefail
api() { bash "$GITHUB_ACTION_PATH/scripts/retry.sh" gh api "repos/$GITHUB_REPOSITORY/$1" --input - --jq .sha; }
# Stage only the paths the fix touched; tests leave untracked artifacts such as __pycache__ behind.
git add -A -- "${@:2}"
# Only the edited blobs are new to GitHub, which hashes them to the same SHAs as the index; whatever a merge brings in already exists there.
git diff --cached --no-renames --diff-filter=AM --name-only -z -- "${@:2}" | while IFS= read -r -d '' path; do
  base64 < "$path" | tr -d '\n' | jq -Rs '{content: ., encoding: "base64"}' | api git/blobs > /dev/null
done
tree=$(git diff --cached --no-renames --name-only -z HEAD | while IFS= read -r -d '' path; do
  staged=($(git ls-files -s -- "$path"))
  jq -n --arg path "$path" --arg mode "${staged[0]:-100644}" --arg sha "${staged[1]}" '{path: $path, mode: $mode, type: "blob", sha: (if $sha == "" then null else $sha end)}'
done | jq -s --arg base "$(git rev-parse 'HEAD^{tree}')" '{base_tree: $base, tree: .}' | api git/trees)
commit=$(git rev-parse HEAD $(git rev-parse -q --verify MERGE_HEAD) | jq -R . | jq -s --arg message "$1" --arg tree "$tree" '{message: $message, tree: $tree, parents: .}' | api git/commits)
# Without force GitHub only fast-forwards, so a branch that moved past HEAD rejects the commit.
jq -n --arg sha "$commit" '{sha: $sha}' | bash "$GITHUB_ACTION_PATH/scripts/retry.sh" gh api -X PATCH "repos/$GITHUB_REPOSITORY/git/refs/heads/$HEAD_BRANCH" --input - > /dev/null
echo "$commit"
bash "$GITHUB_ACTION_PATH/scripts/retry.sh" git fetch -q origin "$HEAD_BRANCH" < /dev/null
git reset -q --hard FETCH_HEAD
