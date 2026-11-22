"""Run with python3 scripts/test-commit-fix.py (requires Git, Bash and jq).

All commits and simulated API calls target disposable local Git databases.
"""

import base64
import json
import os
import shlex
from pathlib import Path
import subprocess
import sys
import tempfile

COMMIT = Path(__file__).resolve().with_name("commit-fix.sh")
ZERO = "0" * 40
ENV = {name: value for name, value in os.environ.items() if not name.startswith("GIT_")}
ENV.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL="/dev/null",
           GIT_AUTHOR_NAME="Offline fixture", GIT_AUTHOR_EMAIL="fixture@example.test",
           GIT_COMMITTER_NAME="Offline fixture", GIT_COMMITTER_EMAIL="fixture@example.test")

def run(cmd, cwd=None, env=None, input=None):
    out = subprocess.run(cmd, cwd=cwd, env=env or ENV, input=input, capture_output=True)
    if out.returncode != 0:
        raise RuntimeError(f"{cmd} failed ({out.returncode}): {out.stderr.decode(errors='replace')}")
    return out.stdout

def git(wd, *args, env=None, input=None):
    return run(["git", "-C", str(wd), *args], env=env, input=input)

def mocked_gh():
    assert sys.argv[2] == "api", sys.argv
    root = Path(os.environ["MOCK_GH_ROOT"])
    remote = os.environ["MOCK_GH_DB"]
    route = next(x for x in sys.argv[2:] if x.startswith("repos/offline/fixture/")).removeprefix("repos/offline/fixture/")
    req = json.load(sys.stdin)
    with open(os.environ["MOCK_GH_LOG"], "a") as log:
        log.write(json.dumps([route, req]) + "\n")
    if route == "git/blobs":
        assert req["encoding"] == "base64", req
        sys.stdout.buffer.write(git(remote, "hash-object", "-w", "--stdin", input=base64.b64decode(req["content"])))
    elif route == "git/trees":
        assert req["tree"], "real API rejects empty tree"
        with tempfile.TemporaryDirectory(dir=root) as td:
            env = dict(ENV, GIT_INDEX_FILE=str(Path(td) / "index"))
            git(remote, "read-tree", req["base_tree"], env=env)
            for row in req["tree"]:
                assert row["type"] == ("commit" if row["mode"] == "160000" else "blob"), row
                if row["sha"] is not None:
                    if row["mode"] != "160000":
                        git(remote, "cat-file", "-e", row["sha"] + "^{blob}")
                    mode, sha = row["mode"], row["sha"]
                else:
                    mode, sha = "0", ZERO
                update = f"{mode} {sha}\t{row['path']}\0".encode()
                git(remote, "update-index", "-z", "--index-info", env=env, input=update)
            sys.stdout.buffer.write(git(remote, "write-tree", env=env))
    elif route == "git/commits":
        parents = [a for p in req["parents"] for a in ("-p", p)]
        sys.stdout.buffer.write(git(remote, "commit-tree", req["tree"], *parents, "-m", req["message"]))
    elif route.startswith("git/refs/heads/"):
        ref = route.removeprefix("git/")
        old = git(remote, "rev-parse", ref).decode().strip()
        git(remote, "merge-base", "--is-ancestor", old, req["sha"])
        git(remote, "update-ref", ref, req["sha"], old)
    else:
        raise AssertionError(sys.argv)

class Fixture:
    def __init__(self, name, before):
        self.dir = ROOT / name
        self.dir.mkdir()
        self.work = self.dir / "work"
        self.work.mkdir()
        self.db = self.dir / "github.git"
        self.log = self.dir / "requests.jsonl"
        git(self.work, "init", "-q", "-b", "head")
        before(self.work)
        git(self.work, "add", "-A")
        git(self.work, "commit", "-qm", "fixture base")
        self.original = git(self.work, "rev-parse", "HEAD").decode().strip()
        git(self.work, "clone", "-q", "--bare", ".", str(self.db))
        git(self.work, "remote", "add", "origin", str(self.db))
    def publish(self, *paths):
        env = dict(ENV, GITHUB_ACTION_PATH=str(ROOT), GITHUB_REPOSITORY="offline/fixture",
                   HEAD_BRANCH="head", MOCK_GH_DB=str(self.db), MOCK_GH_LOG=str(self.log),
                   MOCK_GH_ROOT=str(ROOT),
                   PATH=str(ROOT / "bin") + os.pathsep + os.environ["PATH"])
        run(["bash", str(COMMIT), "fixture change", *paths], cwd=self.work, env=env)
        assert self.rev("HEAD") == self.remote_rev("head")
    def rev(self, target):
        return git(self.work, "rev-parse", target).decode().strip()
    def remote_rev(self, target):
        return git(self.db, "rev-parse", target).decode().strip()
    def blob(self, name):
        return git(self.db, "show", f"head:{name}")
    def entry(self, name):
        out = git(self.db, "--literal-pathspecs", "ls-tree", "-z", "head", "--", name)
        return out.split(b"\t", 1)[0].decode().split() if out else None
    def requests(self, route):
        return [v for p,v in map(json.loads, self.log.read_text().splitlines()) if route == p]
    def pass_(self, description):
        print(f"PASS {description}")

def init_basic(w):
    (w/"plain").write_text("base\n")

def unchanged_merge():
    f = Fixture("unchanged", init_basic)
    git(f.work, "branch", "base")
    git(f.work, "commit", "--allow-empty", "-qm", "head parent")
    head = f.rev("HEAD")
    git(f.work, "push", "-q", "origin", "head")
    git(f.work, "switch", "-q", "base")
    git(f.work, "commit", "--allow-empty", "-qm", "base parent")
    base = f.rev("HEAD")
    git(f.work, "push", "-q", "origin", "base")
    git(f.work, "switch", "-q", "head")
    git(f.work, "merge", "--no-commit", "--no-ff", "base")
    f.publish("plain")
    assert f.remote_rev("head^{tree}") == f.remote_rev(head+"^{tree}")
    assert f.requests("git/trees") == [] and f.requests("git/blobs") == []
    assert f.requests("git/commits")[0]["parents"] == [head, base]
    f.pass_("same-tree merge reuses the tree and preserves both parents")

def mixed_merge():
    def init(w):
        (w/"auto").write_text("first\nspacer 1\nspacer 2\nspacer 3\nlast\n")
        (w/"resolve[1]").write_text("common\n")
    f = Fixture("mixed-merge", init)
    git(f.work, "branch", "base")
    (f.work/"auto").write_text("head first\nspacer 1\nspacer 2\nspacer 3\nlast\n")
    (f.work/"resolve[1]").write_text("head change\n")
    (f.work/"head-only").write_text("already in head\n")
    git(f.work, "add", "-A")
    git(f.work, "commit", "-qm", "head changes")
    head = f.rev("HEAD")
    git(f.work, "push", "-q", "origin", "head")
    git(f.work, "switch", "-q", "base")
    (f.work/"auto").write_text("first\nspacer 1\nspacer 2\nspacer 3\nbase last\n")
    (f.work/"resolve[1]").write_text("base change\n")
    (f.work/"base-only").write_text("already in base\n")
    git(f.work, "add", "-A")
    git(f.work, "commit", "-qm", "base changes")
    base = f.rev("HEAD")
    git(f.work, "push", "-q", "origin", "base")
    git(f.work, "switch", "-q", "head")
    merge = subprocess.run(["git", "merge", "--no-commit", "--no-ff", "base"],
                           cwd=f.work, env=ENV, capture_output=True)
    assert merge.returncode == 1, merge
    assert git(f.work, "diff", "--name-only", "--diff-filter=U", "-z") == b"resolve[1]\0"
    (f.work/"resolve[1]").write_text("manual resolution\n")
    (f.work/"resolve1").write_text("unrequested neighbor\n")
    automatic = b"head first\nspacer 1\nspacer 2\nspacer 3\nbase last\n"
    assert git(f.work, "show", ":0:auto") == automatic
    git(f.work, "--literal-pathspecs", "add", "--", "resolve[1]")
    expected = git(f.work, "write-tree").decode().strip()
    # Restore the conflict stages so the helper must stage the working-tree resolution itself.
    git(f.work, "update-index", "--unresolve", "resolve[1]")
    f.publish("resolve[1]")
    assert f.remote_rev("head^{tree}") == expected
    assert f.requests("git/commits")[0]["parents"] == [head, base]
    assert sorted(base64.b64decode(x["content"]) for x in f.requests("git/blobs")) == [
        automatic, b"manual resolution\n"
    ]
    assert f.blob("base-only") == b"already in base\n"
    assert f.blob("head-only") == b"already in head\n"
    assert f.entry("resolve1") is None
    f.pass_("mixed merge uploads auto-merged and resolved blobs and reuses both parents' blobs")

def ignored_submodule_merge():
    def init(w):
        init_basic(w)
        (w/"module").mkdir()
        (w/".gitmodules").write_text('[submodule "module"]\n\tpath = module\n\tignore = all\n')
        git(w, "update-index", "--add", "--cacheinfo", f"160000,{'1'*40},module")
    f = Fixture("ignored-submodule", init)
    git(f.work, "switch", "-qc", "base")
    git(f.work, "update-index", "--cacheinfo", f"160000,{'2'*40},module")
    git(f.work, "commit", "-qm", "advance submodule")
    git(f.work, "push", "-q", "origin", "base")
    git(f.work, "switch", "-q", "head")
    git(f.work, "merge", "--no-commit", "--no-ff", "base")
    f.publish("plain")
    assert f.remote_rev("head^{tree}") == f.remote_rev("base^{tree}")
    assert f.requests("git/commits")[0]["parents"] == [f.original, f.remote_rev("base")]
    f.pass_("merge preserves a staged update to an ignored submodule")

def indexed_blobs():
    def init(w):
        init_basic(w)
        (w/".gitattributes").write_text("eols.txt text eol=lf\n")
    f = Fixture("stage-blobs", init)
    (f.work/"sym").symlink_to("plain")
    (f.work/"eols.txt").write_bytes(b"hello\r\nworld\r\n")
    f.publish("sym", "eols.txt")
    assert f.blob("sym") == b"plain" and f.entry("sym")[:2] == ["120000", "blob"]
    assert f.blob("eols.txt") == b"hello\nworld\n"
    assert sorted(base64.b64decode(x["content"]) for x in f.requests("git/blobs")) == [b"hello\nworld\n", b"plain"]
    f.pass_("symlinks and CRLF upload their exact index bytes")

def type_changes():
    def init(w):
        (w/"to-link").write_text("old file\n")
        git(w, "update-index", "--add", "--cacheinfo", f"160000,{'1'*40},to-file")
        (w/"to-file").mkdir()
    f = Fixture("types", init)
    assert f.entry("to-file")[:2] == ["160000", "commit"]
    git(f.work, "config", "diff.ignoreSubmodules", "all")
    (f.work/"to-file").rmdir()
    (f.work/"to-file").write_text("new normal file\n")
    (f.work/"to-link").unlink()
    (f.work/"to-link").mkdir()
    git(f.work/"to-link", "init", "-q")
    git(f.work/"to-link", "commit", "--allow-empty", "-qm", "gitlink object")
    gitlink_sha = git(f.work/"to-link", "rev-parse", "HEAD").decode().strip()
    f.publish("to-file", "to-link")
    assert f.blob("to-file") == b"new normal file\n" and f.entry("to-file")[:2] == ["100644", "blob"]
    assert f.entry("to-link") == ["160000", "commit", gitlink_sha]
    assert [base64.b64decode(x["content"]) for x in f.requests("git/blobs")] == [b"new normal file\n"]
    f.pass_("regular file ↔ gitlink transitions despite diff.ignoreSubmodules=all")

def literal_paths():
    def init(w):
        for p in ["a[1]", "a1", "deletion", "directory/item"]:
            target = w / p
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("old " + p + "\n")
    f = Fixture("paths", init)
    (f.work/"a[1]").write_text("new requested bracket file\n")
    (f.work/"a1").write_text("unrequested neighbor\n")
    (f.work/"b[1]").write_text("new requested addition\n")
    (f.work/"b1").write_text("unrequested untracked neighbor\n")
    (f.work/"directory"/"item").write_text("new child\n")
    (f.work/"deletion").unlink()
    f.publish("a[1]", "b[1]", "directory", "deletion")
    assert f.blob("a[1]") == b"new requested bracket file\n"
    assert f.blob("a1") == b"old a1\n"
    assert f.blob("b[1]") == b"new requested addition\n"
    assert f.entry("b1") is None
    assert f.blob("directory/item") == b"new child\n"
    assert f.entry("deletion") is None
    f.pass_("literal staging and index lookup; directory changes and deletions still work")

def file_to_directory():
    f = Fixture("file-to-directory", init_basic)
    (f.work/"plain").unlink()
    (f.work/"plain").mkdir()
    (f.work/"plain"/"child").write_text("new child\n")
    f.publish("plain")
    # GitHub requires an explicit deletion before a nested entry can replace a blob.
    rows = {row["path"]: row for row in f.requests("git/trees")[0]["tree"]}
    assert rows["plain"]["sha"] is None
    assert f.blob("plain/child") == b"new child\n"
    f.pass_("a directory replaces a tracked file")

if __name__ == "__main__":
    if sys.argv[1:] and sys.argv[1] == "--mock-gh":
        mocked_gh()
    else:
        with tempfile.TemporaryDirectory(prefix="commit-fix-") as tmp:
            ROOT = Path(tmp)
            (ROOT / "scripts").mkdir()
            (ROOT / "scripts/retry.sh").write_text('#!/usr/bin/env bash\nexec "$@"\n')
            (ROOT / "bin").mkdir()
            gh = ROOT / "bin/gh"
            gh.write_text(f'#!/bin/sh\nexec {shlex.quote(sys.executable)} '
                          f'{shlex.quote(str(Path(__file__).resolve()))} --mock-gh "$@"\n')
            gh.chmod(0o755)
            for test in (unchanged_merge, mixed_merge, ignored_submodule_merge, indexed_blobs, type_changes, literal_paths, file_to_directory):
                test()
