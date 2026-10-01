"""A project copy that is already here: gitimport.status and gitimport.update,
with real git against a bare repository in tmp_path as the "remote" (no network)."""
import asyncio
import shutil
import subprocess
from pathlib import Path

import pytest

from wadd import gitimport
from wadd.gitimport import Update, parse_status

TOKEN = "ghp_" + "U" * 36


def run(cwd: Path, *args: str) -> str:
    return subprocess.run(["git", "-c", "user.name=T", "-c", "user.email=t@example.com",
                           "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false", *args],
                          cwd=cwd, check=True, capture_output=True, text=True).stdout


def commit(repo: Path, name: str, text: str = "x") -> None:
    (repo / name).write_text(text)
    run(repo, "add", name)
    run(repo, "commit", "-q", "-m", f"add {name}")


class Remote:
    """origin.git (bare), a "laptop" clone that pushes to it, and the project
    folder under test (a clone, like a launch makes)."""

    def __init__(self, root: Path, project: Path):
        self.bare = root / "origin.git"
        self.laptop = root / "laptop"
        self.project = project
        root.mkdir(parents=True, exist_ok=True)
        run(root, "init", "-q", "--bare", "-b", "main", str(self.bare))
        run(root, "clone", "-q", str(self.bare), str(self.laptop))
        commit(self.laptop, "README.md", "hello")
        run(self.laptop, "push", "-q", "origin", "main")
        project.parent.mkdir(parents=True, exist_ok=True)
        run(root, "clone", "-q", str(self.bare), str(project))

    def push_new(self, n: int) -> None:
        for i in range(n):
            commit(self.laptop, f"new{i}.md")
        run(self.laptop, "push", "-q", "origin", "main")

    def head(self, repo: Path) -> str:
        return run(repo, "rev-parse", "HEAD").strip()


@pytest.fixture
def remote(tmp_path):
    return Remote(tmp_path / "remote", tmp_path / "projects" / "p1")


def update(path, **kw) -> Update:
    return asyncio.run(gitimport.update(path, **kw))


def test_clean_and_behind_fast_forwards(remote):
    remote.push_new(3)
    assert update(remote.project) == Update("updated", 3)
    assert remote.head(remote.project) == remote.head(remote.laptop)
    assert (remote.project / "new2.md").exists()
    assert update(remote.project) == Update("current")


def test_uncommitted_changes_are_left_alone(remote):
    remote.push_new(1)
    (remote.project / "README.md").write_text("my edit")
    before = remote.head(remote.project)
    assert update(remote.project) == Update("dirty")
    assert remote.head(remote.project) == before and (remote.project / "README.md").read_text() == "my edit"


def test_untracked_files_count_as_changes(remote):
    remote.push_new(1)
    (remote.project / "draft.md").write_text("not added yet")
    assert update(remote.project).state == "dirty"


def test_unpushed_commits_are_left_alone(remote):
    remote.push_new(2)
    commit(remote.project, "mine.md")
    before = remote.head(remote.project)
    assert update(remote.project) == Update("ahead", 1)
    assert remote.head(remote.project) == before


def test_no_upstream_is_left_alone(remote):
    remote.push_new(1)
    run(remote.project, "checkout", "-q", "-b", "local-only")
    assert update(remote.project) == Update("no-upstream")
    run(remote.project, "checkout", "-q", "--detach")
    assert update(remote.project) == Update("no-upstream")


def test_a_failed_fetch_is_only_a_warning(remote):
    remote.push_new(1)
    shutil.rmtree(remote.bare)
    up = update(remote.project)
    assert up.state == "offline" and "fatal:" in up.error
    assert not (remote.project / "new0.md").exists()


def test_a_slow_fetch_times_out(remote, monkeypatch):
    real = gitimport.git

    async def slow(path, *args, **kw):
        if args[0] == "fetch":  # git that hangs, given the timeout update() asks for
            await asyncio.wait_for(asyncio.sleep(5), kw["timeout"])
        return await real(path, *args, **kw)
    monkeypatch.setattr(gitimport, "git", slow)
    up = update(remote.project, fetch_timeout=0.05)
    assert up.state == "offline" and "longer than" in up.error


def test_not_a_git_repository(tmp_path):
    (tmp_path / "plain").mkdir()
    assert update(tmp_path / "plain") == Update("not-git")
    assert asyncio.run(gitimport.status(tmp_path / "plain")) is None


def test_status_from_local_refs(remote):
    st = asyncio.run(gitimport.status(remote.project))
    assert st == {"branch": "main", "dirty": False, "ahead": 0, "behind": 0, "upstream": "origin/main"}
    remote.push_new(2)
    # No fetch in status: it doesn't know about the new commits yet.
    assert asyncio.run(gitimport.status(remote.project))["behind"] == 0
    run(remote.project, "fetch", "-q")
    commit(remote.project, "mine.md")
    (remote.project / "mine.md").write_text("changed")
    st = asyncio.run(gitimport.status(remote.project))
    assert st == {"branch": "main", "dirty": True, "ahead": 1, "behind": 2, "upstream": "origin/main"}


def test_parse_status():
    assert parse_status("# branch.oid abc\n# branch.head (detached)\n") == {
        "branch": None, "dirty": False, "ahead": 0, "behind": 0, "upstream": None}
    # An upstream that is gone has no ab line: as good as none.
    assert parse_status("# branch.head main\n# branch.upstream origin/gone\n")["upstream"] is None
    assert parse_status("# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -5\n? x\n") == {
        "branch": "main", "dirty": True, "ahead": 2, "behind": 5, "upstream": "origin/main"}


def test_the_token_is_only_for_github_and_only_in_the_environment(remote, monkeypatch):
    seen = []
    real = asyncio.create_subprocess_exec

    async def record(*cmd, env=None, **kw):
        seen.append((cmd, env))
        return await real(*cmd, env=env, **kw)
    monkeypatch.setattr(gitimport.asyncio, "create_subprocess_exec", record)
    update(remote.project, token=TOKEN)
    cmd, env = next((c, e) for c, e in seen if "fetch" in c)
    assert not any(TOKEN in a for a in cmd) and env["WADD_GH_TOKEN"] == TOKEN
    assert "credential.helper=" in cmd and f"credential.https://github.com.helper={gitimport.HELPER}" in cmd
    assert env["GIT_TERMINAL_PROMPT"] == "0"
    # Only the fetch gets it.
    assert all("WADD_GH_TOKEN" not in e for c, e in seen if "fetch" not in c)
