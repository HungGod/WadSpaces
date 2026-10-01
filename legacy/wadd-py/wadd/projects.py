"""Projects: folders of work that wadspaces mount, kept apart from the images.

A project is a folder of work on the host. A launch (wadd/launches.py) mounts
it read-write at ~/Desktop/<mountName> in a workspace, so edits live on the
host and survive the container, and one image runs with whichever projects you
pick. Where the folder is depends on the project's source:
  - git: a GitHub repo. GitHub is where its files live, and machines move work
    with ordinary commit, push and pull; each machine has its copy at
    <projects_dir>/<id>, owned by projects_uid (abc in the images): a launch
    clones it, or fast-forwards a clean copy.
  - folder: a directory on one machine (machineId: the enrolled machine's id,
    or "local" before it is enrolled), inside daemon.folder_roots.
  - drive: a folder (subpath) on a filesystem known by its UUID, on whichever
    machine the drive is plugged into (drives.py).
What a project is (its name, its source, a setup command) is a small JSON
document under <state_dir>/projects/<id>.json, the same shape as Wad Creator's
users/{uid}/projects/{id} in Firestore, which the cloud relay syncs both ways
(last writer wins on updatedAt):

    {"id", "name", "mountName",
     "source": {"kind": "git", "url": "https://github.com/<owner>/<repo>[.git]", "ref"?}
             | {"kind": "folder", "machineId", "machineName", "path"}
             | {"kind": "drive", "uuid", "label", "fstype", "subpath"},
     "setup": "npm install", "deleted": false,
     "createdAt": <ms>, "updatedAt": <ms>, "synced": bool}

Deleting leaves a tombstone (deleted: true), so the deletion syncs; the folder
on disk is only removed on request (purge). `synced` is local: whether the
cloud has seen this id, which tells a project made offline from one deleted
outright online.

Documents from before (source kind empty or local, or a non-GitHub git url)
still load, marked legacy: true; they launch while <projects_dir>/<id> is on
this machine, and are never pushed to the cloud. Their old Syncthing fields
(holders, ignore, folderId) are dropped wherever they turn up.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import secrets
import shutil
import string
import subprocess
import time
from pathlib import Path

from .config import FOLDER_ROOTS, HOST_PATH_BAD_RE, MOUNT_RE, PROJECT_ID_RE
from .drives import UUID_RE, DriveError, OutsideRoots, clean_subpath, resolve_folder

log = logging.getLogger(__name__)

GITHUB_URL_RE = re.compile(r"^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+?(\.git)?$")
REF_RE = re.compile(r"^[\w./-]{1,200}$")
MAX_SETUP = 4000
NOT_A_SOURCE = "a project is a GitHub repo, a folder or a drive"
NOT_GITHUB = "a git project is a GitHub repo"
MACHINE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
FSTYPE_RE = re.compile(r"^[A-Za-z0-9_.-]{0,32}$")
LOCAL = "local"  # a folder project's machineId on a wadd not (yet) enrolled
# Fields Wad Creator edits; the rest the store keeps itself.
EDITABLE = ("name", "mountName", "source", "setup")
# Syncthing's, from before projects were GitHub repos: dropped on sight.
OLD_FIELDS = ("holders", "ignore", "folderId")


class ProjectError(ValueError):
    """A bad project document (422)."""


class ProjectConflict(ProjectError):
    """Valid on its own, but clashes with another project or a workspace (409)."""


def new_id() -> str:
    """Shaped like a Firestore auto-id: 20 letters and digits."""
    alphabet = string.ascii_letters + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(20))


def now_ms() -> int:
    return int(time.time() * 1000)


def setup_hash(setup: str) -> str:
    """The image runs a project's setup once per hash of the command."""
    return hashlib.sha256((setup or "").encode()).hexdigest()[:12]


def mount_for(name: str) -> str:
    """A folder name (MOUNT_RE) from a repo name: anything else becomes "-"."""
    mount = re.sub(r"[^A-Za-z0-9._-]", "-", name or "")[:64].strip("-")
    return mount if mount and mount not in (".", "..") else "project"


def check_id(pid: str) -> str:
    if not isinstance(pid, str) or not PROJECT_ID_RE.match(pid):
        raise ProjectError(f"bad project id {pid!r}")
    return pid


def is_github_source(source) -> bool:
    return (isinstance(source, dict) and source.get("kind") == "git"
            and bool(GITHUB_URL_RE.match(str(source.get("url") or ""))))


def _text(source: dict, key: str, most: int = 200) -> str:
    v = source.get(key)
    if v is None:
        v = ""
    if not isinstance(v, str) or len(v) > most or "\n" in v:
        raise ProjectError(f"source.{key} is text ({most} characters at most)")
    return v


def check_source(source) -> dict:
    """A project's source, checked as a document (what this machine has on
    disk is put()'s business)."""
    if not isinstance(source, dict) or source.get("kind") not in ("git", "folder", "drive"):
        raise ProjectError(NOT_A_SOURCE)
    kind = source["kind"]
    if kind == "git":
        url = str(source.get("url") or "").strip().rstrip("/")
        if not GITHUB_URL_RE.match(url):
            raise ProjectError(f"{NOT_GITHUB}: {url!r} isn't https://github.com/<owner>/<repo>")
        src = {"kind": "git", "url": url}
        if source.get("ref"):
            ref = str(source["ref"])
            if not REF_RE.match(ref) or ref.startswith("-") or ".." in ref:
                raise ProjectError(f"bad git ref {ref!r}")
            src["ref"] = ref
        return src
    if kind == "folder":
        mid, path = source.get("machineId"), source.get("path")
        if not isinstance(mid, str) or not MACHINE_ID_RE.match(mid):
            raise ProjectError(f"bad source.machineId {mid!r}")
        if (not isinstance(path, str) or not path.startswith("/") or path == "/" or len(path) > 4000
                or os.path.normpath(path) != path or HOST_PATH_BAD_RE.search(path)):
            raise ProjectError(f"source.path {path!r} must be an absolute folder path, without ':' or '%'")
        return {"kind": "folder", "machineId": mid, "machineName": _text(source, "machineName"), "path": path}
    uuid = source.get("uuid")
    if not isinstance(uuid, str) or not UUID_RE.match(uuid):
        raise ProjectError(f"bad source.uuid {uuid!r}")
    fstype = _text(source, "fstype", 32)
    if not FSTYPE_RE.match(fstype):
        raise ProjectError(f"bad source.fstype {fstype!r}")
    try:
        sub = clean_subpath(source.get("subpath") or "")
    except DriveError as e:
        raise ProjectError(str(e)) from None
    if HOST_PATH_BAD_RE.search(sub) or len(sub) > 4000:
        raise ProjectError(f"source.subpath {sub!r} can't have ':' or '%' in it")
    return {"kind": "drive", "uuid": uuid, "label": _text(source, "label"), "fstype": fstype, "subpath": sub}


def is_current_source(source) -> bool:
    try:
        check_source(source)
    except ProjectError:
        return False
    return True


def _stored(doc: dict) -> dict:
    """What goes in the file: no old fields, and no legacy (worked out on read)."""
    return {k: v for k, v in doc.items() if k not in OLD_FIELDS and k != "legacy"}


def clean(doc: dict) -> dict:
    """A stored document as the API shows it: old fields dropped, and
    legacy: true when its source is from before (not a GitHub repo, a folder
    or a drive)."""
    out = _stored(doc)
    if not is_current_source(out.get("source")):
        out["legacy"] = True
    return out


def validate(pid: str, body: dict) -> dict:
    """The editable fields of a project, checked and with defaults filled in."""
    check_id(pid)
    if not isinstance(body, dict):
        raise ProjectError("a project is a JSON object")
    name = str(body.get("name") or "").strip()
    if not name or len(name) > 200:
        raise ProjectError("a project needs a name (200 characters at most)")
    mount = str(body.get("mountName") or "")
    if not MOUNT_RE.match(mount) or mount in (".", ".."):
        raise ProjectError(f"mountName {mount!r} must be a folder name ({MOUNT_RE.pattern})")
    src = check_source(body.get("source"))
    setup = body.get("setup") or ""
    if not isinstance(setup, str) or len(setup) > MAX_SETUP:
        raise ProjectError(f"setup is a shell command ({MAX_SETUP} characters at most)")
    return {"name": name, "mountName": mount, "source": src, "setup": setup}


class ProjectStore:
    """The project documents, one JSON file each (written like library.py's)."""

    def __init__(self, root: Path, folder_roots: list[str] | None = None, machine=None) -> None:
        """machine(): (machine id, machine name) of this wadd, for the folder
        projects made here; folder_roots: where those may be."""
        self.root = Path(root)
        self.folder_roots = list(FOLDER_ROOTS if folder_roots is None else folder_roots)
        self.machine = machine or (lambda: (LOCAL, "wadspaces"))
        # Bumped on every local change (not on what a sync brings in), so
        # the cloud relay knows when there is something to push.
        self.changes = 0

    def _path(self, pid: str) -> Path:
        return self.root / f"{check_id(pid)}.json"

    def _write(self, doc: dict) -> dict:
        doc = _stored(doc)
        path = self._path(doc["id"])
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(doc))
        os.replace(tmp, path)
        return clean(doc)

    def list(self, include_deleted: bool = False) -> list[dict]:
        out = []
        for f in sorted(self.root.glob("*.json")) if self.root.is_dir() else []:
            try:
                doc = json.loads(f.read_text())
            except (OSError, ValueError):
                continue  # a broken file shouldn't hide the rest
            if include_deleted or not doc.get("deleted"):
                out.append(clean(doc))
        return sorted(out, key=lambda d: (d.get("name", "").lower(), d["id"]))

    def get(self, pid: str) -> dict:
        try:
            return clean(json.loads(self._path(pid).read_text()))
        except FileNotFoundError:
            raise KeyError(pid) from None

    def get_or_none(self, pid: str) -> dict | None:
        try:
            return self.get(pid)
        except KeyError:
            return None

    def check_mount(self, pid: str, mount: str) -> None:
        for other in self.list():
            if other["id"] != pid and other.get("mountName") == mount:
                raise ProjectConflict(f"{other['name']!r} already uses the folder name {mount!r}")

    def _here(self, source, old) -> dict:
        """A folder source as this machine's: an existing folder inside the
        folder roots (symlinks resolved), with this machine's id and name. An
        unchanged one (same machine and path) is kept as it is: another
        machine's folder project can still be renamed here."""
        if not isinstance(source, dict) or source.get("kind") != "folder":
            return source
        prev = old.get("source") or {}
        if (prev.get("kind") == "folder" and source.get("path") == prev.get("path")
                and source.get("machineId") in (None, "", prev.get("machineId"))):
            return prev
        path = source.get("path")
        try:
            real = resolve_folder(path, self.folder_roots)
        except OutsideRoots as e:
            raise ProjectError(str(e)) from None
        if not os.path.isdir(real):
            raise ProjectError(f"folder {path} doesn't exist on this machine")
        mid, name = self.machine()
        return {"kind": "folder", "machineId": mid, "machineName": name, "path": real}

    def put(self, pid: str, body: dict) -> dict:
        """Create or update (and undelete). The store sets the timestamps."""
        old = self.get_or_none(pid) or {}
        if isinstance(body, dict):
            body = {**body, "source": self._here(body.get("source"), old)}
        fields = validate(pid, body)
        self.check_mount(pid, fields["mountName"])
        t = max(now_ms(), int(old.get("updatedAt") or 0) + 1)  # always newer than what it replaces
        doc = {"id": pid, **fields, "deleted": False, "createdAt": old.get("createdAt") or t, "updatedAt": t,
               "synced": bool(old.get("synced"))}
        self.changes += 1
        return self._write(doc)

    def delete(self, pid: str) -> dict:
        """Tombstone it (the files stay; see purge_dir)."""
        doc = self.get(pid)
        if doc.get("deleted"):
            return doc
        doc.update(deleted=True, updatedAt=max(now_ms(), int(doc.get("updatedAt") or 0) + 1))
        self.changes += 1
        return self._write(doc)

    def merge(self, remote: list[dict]) -> list[dict]:
        """Bring in the cloud's documents, newest updatedAt winning. Returns
        the local documents the cloud should get (newer here, or never sent;
        never a legacy one, which the cloud would refuse). A project the cloud
        knew but no longer has was deleted outright there: it becomes a
        tombstone here too."""
        local = {d["id"]: d for d in self.list(include_deleted=True)}
        push: list[dict] = []
        seen = set()
        for r in remote:
            pid = r.get("id")
            try:
                check_id(pid)
            except ProjectError:
                log.warning("ignoring a cloud project with a bad id %r", pid)
                continue
            seen.add(pid)
            mine = local.get(pid)
            theirs = int(r.get("updatedAt") or 0)
            if mine is None or theirs > int(mine.get("updatedAt") or 0):
                try:
                    fields = validate(pid, r) if not r.get("deleted") else self._tombstone_fields(r, mine)
                except ProjectError as e:
                    log.warning("ignoring cloud project %s: %s", pid, e)
                    continue
                self._write({"id": pid, **fields, "deleted": bool(r.get("deleted")),
                             "createdAt": int(r.get("createdAt") or theirs), "updatedAt": theirs,
                             "synced": True})
            elif theirs < int(mine.get("updatedAt") or 0):
                push.append(mine)
            elif not mine.get("synced"):
                self._write({**mine, "synced": True})
        for pid, mine in local.items():
            if pid in seen:
                continue
            if mine.get("synced"):
                if not mine.get("deleted"):
                    log.info("project %s is gone from the cloud; marking it deleted here", pid)
                    self._write({**mine, "deleted": True})
            else:
                push.append(mine)
        legacy = [d["id"] for d in push if d.get("legacy")]
        if legacy:
            log.info("not sending projects that aren't GitHub repos to the cloud: %s", ", ".join(legacy))
        return [d for d in push if not d.get("legacy")]

    @staticmethod
    def _tombstone_fields(remote: dict, mine: dict | None) -> dict:
        """A deleted project from the cloud may be partial; keep what we had."""
        base = {k: (mine or {}).get(k) for k in EDITABLE}
        base.update({k: remote[k] for k in EDITABLE if remote.get(k) is not None})
        base.setdefault("name", remote.get("id"))
        return {"name": base.get("name") or "", "mountName": base.get("mountName") or "",
                "source": base.get("source") or {}, "setup": base.get("setup") or ""}

    def claim_local(self, machine_id: str, machine_name: str) -> list[str]:
        """Folder projects made before this machine was enrolled (machineId
        "local") become this machine's, before they go to the cloud."""
        out = []
        for doc in self.list():
            src = doc.get("source") or {}
            if src.get("kind") == "folder" and src.get("machineId") == LOCAL:
                t = max(now_ms(), int(doc.get("updatedAt") or 0) + 1)
                self._write({**doc, "source": {**src, "machineId": machine_id, "machineName": machine_name},
                             "updatedAt": t})
                out.append(doc["id"])
        if out:
            self.changes += 1
        return out

    def mark_synced(self, ids: list[str]) -> None:
        for pid in ids:
            doc = self.get_or_none(pid)
            if doc is not None and not doc.get("synced"):
                self._write({**doc, "synced": True})


# ------------------------------------------------------------ folders on disk
def project_dir(projects_dir: str | Path, pid: str) -> Path:
    return Path(projects_dir) / check_id(pid)


def is_root() -> bool:
    return os.geteuid() == 0


def relabel(path: Path, recursive: bool = False) -> None:
    """Best effort: give a folder SELinux's container_file_t, so containers
    (which mount it with :z anyway) can use it. Files made inside it
    afterwards inherit the type. Silent without SELinux or chcon."""
    if not shutil.which("chcon") or not Path("/sys/fs/selinux/enforce").exists():
        return
    cmd = ["chcon", *(["-R"] if recursive else []), "-t", "container_file_t", str(path)]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    except (OSError, subprocess.TimeoutExpired) as e:
        log.warning("labelling %s for containers failed: %s", path, e)
        return
    if r.returncode != 0:
        log.warning("labelling %s for containers failed: %s", path, r.stderr.strip())


def make_owned_dir(path: Path, uid: int, mode: int = 0o755) -> Path:
    """Create a directory for projects_uid: owned by it when wadd runs as root
    (on a dev laptop wadd already runs as that user), and labelled for
    containers."""
    path = Path(path)
    path.mkdir(parents=True, exist_ok=True)
    os.chmod(path, mode)
    if is_root():
        os.chown(path, uid, uid)
    relabel(path)
    return path


def purge_dir(projects_dir: str | Path, pid: str) -> bool:
    """Remove a project's folder and everything in it. False if there was none."""
    path = project_dir(projects_dir, pid)
    if not path.exists():
        return False
    shutil.rmtree(path)
    return True


def write_manifest(state_dir: str | Path, ws_id: str, projects: list[dict]) -> Path:
    """<state_dir>/extra/<ws>/projects.json: what the image's wadspaces-projects
    reads at /run/wadspaces-extra. projects: [{id, name, mount, setup}]."""
    d = Path(state_dir) / "extra" / ws_id
    d.mkdir(parents=True, exist_ok=True)
    os.chmod(d, 0o755)
    data = {"version": 1, "projects": [
        {"id": p["id"], "name": p["name"], "mount": p["mount"], "setup": p.get("setup") or "",
         "setupHash": setup_hash(p.get("setup") or "")} for p in projects]}
    path = d / "projects.json"
    tmp = d / ".projects.json.tmp"
    tmp.write_text(json.dumps(data, indent=2) + "\n")
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)
    return path
