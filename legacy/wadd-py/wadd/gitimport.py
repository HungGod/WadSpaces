"""Projects' git on the host: the first `git clone`, and keeping a copy current.

The clone goes into <dest>.part and is renamed into place only when it worked,
so a project folder is never half there; a failed or cancelled clone leaves
nothing behind. When wadd runs as root, git runs as projects_uid (abc in the
images), with its own HOME, so the files belong to the user who works on them.

For github.com the token is podman's `github_token` secret (the same one the
workspaces push with). git gets it from an inline credential helper that reads
it from the environment: it is never on a command line (visible in ps) or in
the log.

A project folder that is already here is brought up to date at launch
(update()): `git fetch`, then a fast-forward, but only when that can't lose or
tangle anything: a clean working tree, an upstream branch, nothing unpushed.
Otherwise it is left as it is and update() says why. status() is the same
picture from the refs already here (no network), for the status call.
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Callable
from urllib.parse import urlparse

log = logging.getLogger(__name__)

TOKEN_ENV = "WADD_GH_TOKEN"
# git asks the helper for credentials; it answers from TOKEN_ENV.
HELPER = '!f() { echo username=x-access-token; echo "password=$' + TOKEN_ENV + '"; }; f'
PROGRESS_RE = re.compile(r"Receiving objects:\s+(\d+)%")
TAIL = 20  # stderr lines kept for the error message
FETCH_TIMEOUT = 60
LOCAL_TIMEOUT = 20  # status and merge: no network

# on_line(text, fraction or None): each line git writes, and how far the
# download is when the line is a "Receiving objects: NN%" one.
LineCb = Callable[[str, "float | None"], None]


class GitImportError(RuntimeError):
    pass


def is_github(url: str) -> bool:
    return urlparse(url).scheme == "https" and (urlparse(url).hostname or "").lower() == "github.com"


def parse_progress(line: str) -> float | None:
    m = PROGRESS_RE.search(line)
    return int(m.group(1)) / 100 if m else None


async def find_token(api, secrets_dir: str | Path | None = None) -> str | None:
    """The github_token podman secret, else the file it is seeded from."""
    try:
        value = await api.secret_value("github_token")
        if value:
            return value.strip()
    except Exception as e:  # noqa: BLE001 - fall back to the baked file
        log.debug("github_token from podman: %s", e)
    if secrets_dir:
        try:
            return (Path(secrets_dir) / "podman" / "github_token").read_text().strip() or None
        except OSError:
            pass
    return None


def _home(projects_dir: Path, uid: int | None) -> Path:
    """git's HOME when running as projects_uid: private, and theirs."""
    home = Path(projects_dir) / ".home"
    home.mkdir(mode=0o700, parents=True, exist_ok=True)
    if uid is not None and os.geteuid() == 0:
        os.chown(home, uid, uid)
    return home


def _env(projects_dir: Path, as_user: int | None) -> dict:
    return {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": str(_home(projects_dir, as_user)) if as_user is not None else os.environ.get("HOME", "/"),
        "LC_ALL": "C",  # the output is parsed
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_SSH_COMMAND": "ssh -o BatchMode=yes",
    }


def _as_user(uid: int | None) -> int | None:
    return uid if os.geteuid() == 0 and uid is not None else None


def _remove(path: Path) -> None:
    if path.exists():
        shutil.rmtree(path, ignore_errors=True)


async def clone(url: str, ref: str | None, dest: str | Path, token: str | None = None,
                on_line: LineCb | None = None, *, uid: int | None = None,
                prepare: Callable[[Path], None] | None = None) -> None:
    """git clone url (at ref) into dest, through dest.part.

    uid: run git as this user when wadd is root (ignored otherwise).
    prepare(path): called on the empty .part folder before git fills it
    (ownership and SELinux label, which the files then inherit)."""
    dest = Path(dest)
    if dest.exists():
        raise GitImportError(f"{dest} already exists")
    part = dest.with_name(dest.name + ".part")
    _remove(part)  # left over from a crash
    as_user = _as_user(uid)
    part.mkdir(parents=True)
    if prepare:
        prepare(part)
    elif as_user is not None:
        os.chown(part, as_user, as_user)

    env = _env(dest.parent, as_user)
    cmd = ["git"]
    if token and is_github(url):
        env[TOKEN_ENV] = token
        cmd += ["-c", "credential.helper=", "-c", f"credential.helper={HELPER}"]
    cmd += ["clone", "--progress"]
    if ref:
        cmd += ["--branch", ref]
    cmd += ["--", url, str(part)]
    kw = {"user": as_user, "group": as_user, "extra_groups": []} if as_user is not None else {}

    tail: list[str] = []
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd, env=env, cwd=str(dest.parent), stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE, **kw)
    except FileNotFoundError:
        _remove(part)
        raise GitImportError("git is not installed on this machine") from None
    try:
        # git redraws its progress with \r; each redraw is a line here.
        buf = b""
        while chunk := await proc.stderr.read(4096):
            buf += chunk
            *done, buf = re.split(rb"[\r\n]", buf)
            for raw in done:
                _line(raw, tail, on_line)
        if buf:
            _line(buf, tail, on_line)
        code = await proc.wait()
    except BaseException:  # cancelled (or anything else): stop git, leave nothing
        if proc.returncode is None:
            proc.kill()
            await proc.wait()
        _remove(part)
        raise
    if code != 0:
        _remove(part)
        why = next((t for t in reversed(tail) if t.startswith(("fatal:", "error:", "remote:"))), None)
        raise GitImportError(f"git clone {url} failed: {why or (tail[-1] if tail else f'exit {code}')}")
    os.rename(part, dest)


def _line(raw: bytes, tail: list[str], on_line: LineCb | None) -> None:
    text = raw.decode(errors="replace").strip()
    if not text:
        return
    tail.append(text)
    del tail[:-TAIL]
    if on_line:
        on_line(text, parse_progress(text))


# ------------------------------------------------------- a copy that's here
@dataclass
class Update:
    """What update() did. state: updated (count new commits) | current |
    dirty | ahead (count unpushed) | no-upstream | not-git | offline (fetch
    failed: error) | stuck (the fast-forward failed: error)."""
    state: str
    count: int = 0
    error: str | None = None


async def git(path: str | Path, *args: str, uid: int | None = None, token: str | None = None,
              timeout: float = LOCAL_TIMEOUT) -> tuple[int, str, str]:
    """Run git in a project folder (as uid when wadd is root): (code, stdout,
    stderr). With token, git can answer github.com's password prompt with it
    (the helper is scoped to https://github.com, so no other host sees it)."""
    path = Path(path)
    as_user = _as_user(uid)
    env = {**_env(path.parent, as_user),
           "GIT_OPTIONAL_LOCKS": "0",  # status: no index rewrite
           "GIT_CEILING_DIRECTORIES": str(path.parent)}  # never a repository the folder is in
    cmd = ["git", "-c", f"safe.directory={path}"]
    if token:
        env[TOKEN_ENV] = token
        cmd += ["-c", "credential.helper=", "-c", f"credential.https://github.com.helper={HELPER}"]
    kw = {"user": as_user, "group": as_user, "extra_groups": []} if as_user is not None else {}
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd, *args, env=env, cwd=str(path), stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, **kw)
    except FileNotFoundError:
        raise GitImportError("git is not installed on this machine") from None
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout)
    except BaseException:  # timed out or cancelled: stop git
        if proc.returncode is None:
            proc.kill()
            await proc.wait()
        raise
    return proc.returncode, out.decode(errors="replace"), err.decode(errors="replace")


def _why(err: str, code: int) -> str:
    lines = [t.strip() for t in err.splitlines() if t.strip()]
    return next((t for t in reversed(lines) if t.startswith(("fatal:", "error:"))), lines[-1] if lines else f"exit {code}")


def parse_status(text: str) -> dict:
    """`git status --porcelain=v2 --branch` as {branch, dirty, ahead, behind,
    upstream}. Untracked files count as dirty (a fast-forward could trip on
    them). Without an upstream (or with one that is gone) ahead and behind are 0
    and upstream is None."""
    info = {"branch": None, "dirty": False, "ahead": 0, "behind": 0, "upstream": None}
    upstream = None
    for line in text.splitlines():
        if line.startswith("# branch.head "):
            head = line.split(" ", 2)[2]
            info["branch"] = None if head == "(detached)" else head
        elif line.startswith("# branch.upstream "):
            upstream = line.split(" ", 2)[2]
        elif line.startswith("# branch.ab "):
            a, b = line.split(" ")[2:4]
            info.update(ahead=abs(int(a)), behind=abs(int(b)), upstream=upstream)
        elif line and not line.startswith("#"):
            info["dirty"] = True
    return info


def is_repo(path: str | Path) -> bool:
    return (Path(path) / ".git").exists()


async def status(path: str | Path, uid: int | None = None) -> dict | None:
    """The git state of a project folder from what is here (no fetch); None
    when it isn't a git repository or git can't tell."""
    if not is_repo(path):
        return None
    try:
        code, out, err = await git(path, "status", "--porcelain=v2", "--branch", uid=uid)
    except (GitImportError, asyncio.TimeoutError) as e:
        log.info("git status in %s: %s", path, e or "timed out")
        return None
    if code != 0:
        log.info("git status in %s: %s", path, _why(err, code))
        return None
    return parse_status(out)


async def update(path: str | Path, token: str | None = None, uid: int | None = None,
                 fetch_timeout: float = FETCH_TIMEOUT) -> Update:
    """Fetch, then fast-forward when the copy is clean, has an upstream and
    nothing unpushed. Never raises for git's reasons: a copy that can't be
    brought up to date is still a copy to work in."""
    if not is_repo(path):
        return Update("not-git")
    try:
        code, _, err = await git(path, "fetch", "--quiet", uid=uid, token=token, timeout=fetch_timeout)
        if code != 0:
            return Update("offline", error=_why(err, code))
    except asyncio.TimeoutError:
        return Update("offline", error=f"git fetch took longer than {fetch_timeout:.0f} s")
    except GitImportError as e:
        return Update("offline", error=str(e))
    st = await status(path, uid)
    if st is None:
        return Update("not-git")
    if st["dirty"]:
        return Update("dirty")
    if st["upstream"] is None:
        return Update("no-upstream")
    if st["ahead"]:
        return Update("ahead", st["ahead"])
    if not st["behind"]:
        return Update("current")
    try:
        code, _, err = await git(path, "merge", "--ff-only", "--quiet", "@{u}", uid=uid)
    except (GitImportError, asyncio.TimeoutError) as e:
        return Update("stuck", error=str(e) or "git merge timed out")
    if code != 0:
        return Update("stuck", error=_why(err, code))
    return Update("updated", st["behind"])
