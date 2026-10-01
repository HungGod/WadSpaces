"""Git import: a fake git on PATH records what it was given."""
import asyncio
import json
import os
import sys

import pytest

from wadd import gitimport
from wadd.gitimport import GitImportError, clone, find_token, parse_progress

TOKEN = "ghp_" + "S" * 36

FAKE_GIT = f"""#!{sys.executable}
import json, os, sys, time
args = sys.argv[1:]
with open(os.environ["FAKE_GIT_RECORD"], "w") as f:
    json.dump({{"argv": args, "env": dict(os.environ)}}, f)
dest = args[-1]
for pct in (0, 50, 100):
    sys.stderr.write(f"Receiving objects: {{pct:3d}}% ({{pct}}/100)" + (", done.\\n" if pct == 100 else "\\r"))
    sys.stderr.flush()
open(os.path.join(dest, "README.md"), "w").write("hi")
mode = os.environ.get("FAKE_GIT_MODE", "")
if mode == "fail":
    sys.stderr.write("fatal: repository 'https://github.com/o/r.git/' not found\\n")
    sys.exit(128)
if mode == "slow":
    time.sleep(30)
"""


@pytest.fixture
def git(tmp_path, monkeypatch):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "git").write_text(FAKE_GIT)
    (bin_dir / "git").chmod(0o755)
    record = tmp_path / "record.json"
    monkeypatch.setenv("PATH", f"{bin_dir}:/usr/bin:/bin")
    monkeypatch.setenv("FAKE_GIT_RECORD", str(record))
    # git runs with a clean environment; let the fake's knobs through.
    real_exec = asyncio.create_subprocess_exec

    async def exec_with_knobs(*cmd, env=None, **kw):
        env = {**env, "FAKE_GIT_RECORD": str(record),
               "FAKE_GIT_MODE": os.environ.get("FAKE_GIT_MODE", "")}
        return await real_exec(*cmd, env=env, **kw)
    monkeypatch.setattr(gitimport.asyncio, "create_subprocess_exec", exec_with_knobs)
    return lambda: json.loads(record.read_text())


def test_clone_lands_in_place_with_progress(git, tmp_path):
    dest = tmp_path / "projects" / "p1"
    seen = []
    asyncio.run(clone("https://github.com/o/r.git", "main", dest, TOKEN, lambda t, f: seen.append((t, f))))
    assert (dest / "README.md").read_text() == "hi"
    assert not (tmp_path / "projects" / "p1.part").exists()
    assert [f for _, f in seen] == [0.0, 0.5, 1.0]
    assert seen[-1][0] == "Receiving objects: 100% (100/100), done."
    rec = git()
    assert rec["argv"][-5:] == ["--branch", "main", "--", "https://github.com/o/r.git", str(dest) + ".part"]
    assert rec["env"]["GIT_TERMINAL_PROMPT"] == "0"


def test_the_token_only_travels_in_the_environment(git, tmp_path):
    asyncio.run(clone("https://github.com/o/r.git", None, tmp_path / "p1", TOKEN))
    rec = git()
    assert not any(TOKEN in a for a in rec["argv"])
    assert rec["env"]["WADD_GH_TOKEN"] == TOKEN
    # The previous helpers are reset, then the inline one reads the variable.
    assert rec["argv"][:4] == ["-c", "credential.helper=", "-c", f"credential.helper={gitimport.HELPER}"]
    assert "$WADD_GH_TOKEN" in gitimport.HELPER and "--branch" not in rec["argv"]


def test_no_token_for_other_hosts(git, tmp_path):
    asyncio.run(clone("https://gitlab.com/o/r.git", None, tmp_path / "p1", TOKEN))
    rec = git()
    assert "WADD_GH_TOKEN" not in rec["env"] and rec["argv"][0] == "clone"


def test_a_failed_clone_leaves_nothing(git, tmp_path, monkeypatch):
    monkeypatch.setenv("FAKE_GIT_MODE", "fail")
    with pytest.raises(GitImportError, match="fatal: repository .* not found"):
        asyncio.run(clone("https://github.com/o/r.git", None, tmp_path / "p1", TOKEN))
    assert list(p.name for p in tmp_path.iterdir() if p.name.startswith("p1")) == []


def test_a_cancelled_clone_leaves_nothing(git, tmp_path, monkeypatch):
    monkeypatch.setenv("FAKE_GIT_MODE", "slow")

    async def go():
        task = asyncio.create_task(clone("https://github.com/o/r.git", None, tmp_path / "p1"))
        while not (tmp_path / "p1.part" / "README.md").exists():
            await asyncio.sleep(0.02)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    asyncio.run(go())
    assert not (tmp_path / "p1.part").exists() and not (tmp_path / "p1").exists()


def test_existing_dest_and_leftover_part(git, tmp_path):
    (tmp_path / "p1").mkdir()
    with pytest.raises(GitImportError, match="already exists"):
        asyncio.run(clone("https://github.com/o/r.git", None, tmp_path / "p1"))
    (tmp_path / "p2.part").mkdir()
    (tmp_path / "p2.part" / "junk").write_text("from a crash")
    asyncio.run(clone("https://github.com/o/r.git", None, tmp_path / "p2"))
    assert sorted(p.name for p in (tmp_path / "p2").iterdir()) == ["README.md"]


def test_parse_progress():
    assert parse_progress("Receiving objects:  42% (42/100), 1.2 MiB | 3 MiB/s") == 0.42
    assert parse_progress("Resolving deltas: 100% (5/5), done.") is None


def test_find_token_from_podman_then_the_baked_file(tmp_path):
    class Api:
        value = TOKEN + "\n"

        async def secret_value(self, name):
            assert name == "github_token"
            if self.value is None:
                raise RuntimeError("no podman")
            return self.value
    api = Api()
    assert asyncio.run(find_token(api, tmp_path)) == TOKEN
    api.value = None
    assert asyncio.run(find_token(api, tmp_path)) is None
    (tmp_path / "podman").mkdir()
    (tmp_path / "podman" / "github_token").write_text("ghp_file\n")
    assert asyncio.run(find_token(api, tmp_path)) == "ghp_file"
