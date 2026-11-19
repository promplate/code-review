#!/usr/bin/env bash
# Commit working-tree changes through the Git database API so GitHub signs them as the App (Verified); git push would leave them unsigned. An unfinished git merge becomes a merge commit.
set -eo pipefail
api() { bash "$GITHUB_ACTION_PATH/scripts/retry.sh" gh api "repos/$GITHUB_REPOSITORY/$1" --input - --jq .sha; }
# Stage only the paths the fix touched; tests leave untracked artifacts such as __pycache__ behind.
git --literal-pathspecs add -A -- "${@:2}"
upload_blob() { base64 | tr -d '\n' | jq -Rs '{content: ., encoding: "base64"}' | api git/blobs > /dev/null; }
if git rev-parse -q --verify MERGE_HEAD > /dev/null; then
  # Git can combine edits outside the resolved paths into new blobs that neither parent contains.
  staged_tree=$(git write-tree)
  git rev-list --objects --no-object-names --filter=object:type=blob --filter-provided-objects "$staged_tree" '^HEAD^{tree}' '^MERGE_HEAD^{tree}' | while read -r sha; do
    git cat-file blob "$sha" | upload_blob
  done
else
  # Upload the staged bytes so GitHub computes the same blob IDs as the index.
  git --literal-pathspecs diff --cached --ignore-submodules=none --no-renames --diff-filter=AMT --name-only -z -- "${@:2}" | while IFS= read -r -d '' path; do
    # A type change can replace a file with a submodule, whose commit lives in a different repository.
    [ "$(git --literal-pathspecs ls-files --format='%(objectmode)' -- "$path")" != 160000 ] || continue
    git cat-file blob ":0:$path" | upload_blob
  done
fi
# A merge can add a parent without changing any files. GitHub rejects an empty list of tree entries.
if git rev-parse -q --verify MERGE_HEAD > /dev/null && git diff --cached --ignore-submodules=none --quiet HEAD; then
  tree=$(git rev-parse 'HEAD^{tree}')
else
  tree=$(git diff --cached --ignore-submodules=none --no-renames --raw --no-abbrev -z HEAD | while IFS= read -r -d '' entry && IFS= read -r -d '' path; do
    # Use the diff's exact entry: looking up a deleted file by name also matches children of a directory that replaced it.
    read -r _ mode _ sha status <<< "$entry"
    case "$status" in
      D) mode=100644 sha= ;; # The tree drops a deleted path.
      U) echo "Unresolved conflict in $path" >&2; exit 1 ;;
    esac
    jq -n --arg path "$path" --arg mode "$mode" --arg sha "$sha" '{path: $path, mode: $mode, type: (if $mode == "160000" then "commit" else "blob" end), sha: (if $sha == "" then null else $sha end)}'
  done | jq -s --arg base "$(git rev-parse 'HEAD^{tree}')" '{base_tree: $base, tree: .}' | api git/trees)
fi
commit=$(git rev-parse HEAD $(git rev-parse -q --verify MERGE_HEAD) | jq -R . | jq -s --arg message "$1" --arg tree "$tree" '{message: $message, tree: $tree, parents: .}' | api git/commits)
# Without force GitHub only fast-forwards, so a branch that moved past HEAD rejects the commit.
jq -n --arg sha "$commit" '{sha: $sha}' | bash "$GITHUB_ACTION_PATH/scripts/retry.sh" gh api -X PATCH "repos/$GITHUB_REPOSITORY/git/refs/heads/$HEAD_BRANCH" --input - > /dev/null
echo "$commit"
bash "$GITHUB_ACTION_PATH/scripts/retry.sh" git fetch -q origin "$HEAD_BRANCH" < /dev/null
git reset -q --hard FETCH_HEAD
