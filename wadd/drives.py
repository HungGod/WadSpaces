"""Folders and drives on the host, for projects that aren't GitHub repos.

A folder project is a directory on one machine; a drive project is a folder on
a filesystem known by its UUID, so it works on whichever machine the drive is
plugged into. Both are mounted into a workspace from where they are (no copy).

Folders: anything strictly inside daemon.folder_roots (home folders, where
drives are mounted), after resolving symlinks. browse() lists the folders in
one of them for Wad Creator's folder picker.

Drives: `lsblk --json` lists them (list_drives), leaving out the disk the
system runs from (whatever holds /, /sysroot, /boot, /var or /etc), swap, and
LUKS/LVM members. A drive that isn't mounted yet is mounted on demand:
  - wadd as root (the OS): `systemd-mount` at /run/wadspaces-drives/<uuid>.
    wadd.service runs with ProtectSystem=strict, i.e. in a mount namespace of
    its own: a plain `mount` there would be invisible to podman. systemd-mount
    asks PID 1, which mounts in the host's namespace, and the mount shows up
    in wadd's too.
  - wadd as a user (a laptop): `udisksctl mount`, as the file manager would.
FAT, exFAT and NTFS have no owners, so they are mounted as the projects user.
Every command goes through a runner (run(argv) -> (code, stdout, stderr)) the
tests replace.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
from pathlib import Path
from typing import Awaitable, Callable

log = logging.getLogger(__name__)

DRIVES_DIR = "/run/wadspaces-drives"
LSBLK = ["lsblk", "--json", "-b", "-o", "NAME,UUID,LABEL,FSTYPE,SIZE,MOUNTPOINTS,RM,HOTPLUG,MODEL,PKNAME,TYPE"]
SYSTEM_MOUNTS = ("/", "/sysroot", "/boot", "/var", "/etc")
NOT_DATA = ("swap", "crypto_LUKS", "LVM2_member")
OWNERLESS = ("vfat", "exfat", "ntfs", "ntfs3")  # mounted as the projects user
UUID_RE = re.compile(r"^[A-Za-z0-9-]{1,64}$")
UDISKS_RE = re.compile(r"Mounted \S+ at (.+?)\.?$", re.M)
MOUNT_WAIT_S = 15.0
MAX_DIRS = 500

Runner = Callable[[list[str]], Awaitable[tuple[int, str, str]]]


class DriveError(RuntimeError):
    pass


class DriveMissing(DriveError):
    """The drive isn't plugged in here (409)."""


class OutsideRoots(DriveError):
    """A path outside daemon.folder_roots (403)."""


async def run(argv: list[str], timeout: float = 30.0) -> tuple[int, str, str]:
    try:
        proc = await asyncio.create_subprocess_exec(
            *argv, stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE)
    except FileNotFoundError:
        return 127, "", f"{argv[0]} is not installed"
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return 124, "", f"{argv[0]} timed out"
    return proc.returncode, out.decode(errors="replace"), err.decode(errors="replace")


# ------------------------------------------------------------------ folders
def _inside(path: str, root: str, strictly: bool) -> bool:
    root = os.path.realpath(root)
    if path == root:
        return not strictly
    return path.startswith(root.rstrip("/") + "/")


def resolve_folder(path: str, roots: list[str], strictly: bool = True) -> str:
    """path with symlinks resolved, when it is inside one of the roots (and
    not a root itself, when strictly). OutsideRoots otherwise."""
    if not isinstance(path, str) or not path.startswith("/"):
        raise OutsideRoots(f"{path!r} isn't an absolute path")
    real = os.path.realpath(path)
    if not any(_inside(real, r, strictly) for r in roots):
        raise OutsideRoots(f"{path} isn't inside {', '.join(roots)}")
    return real


def _dirs(path: str, rel_to: str | None = None) -> tuple[list[dict], bool]:
    """The folders in path (not hidden ones), sorted, at most MAX_DIRS. With
    rel_to, paths are given relative to it."""
    out = []
    with os.scandir(path) as it:
        for e in it:
            if e.name.startswith("."):
                continue
            try:
                if not e.is_dir():
                    continue
            except OSError:
                continue
            full = os.path.join(path, e.name)
            out.append({"name": e.name, "path": os.path.relpath(full, rel_to) if rel_to else full})
    out.sort(key=lambda d: (d["name"].lower(), d["name"]))
    return out[:MAX_DIRS], len(out) > MAX_DIRS


def browse(path: str | None, roots: list[str]) -> dict:
    """{path, parent, dirs: [{name, path}]}: the folders in path, which must be
    one of the roots or inside one. No path: the roots there are."""
    if not path:
        here = [r for r in roots if os.path.isdir(r)]
        return {"path": None, "parent": None, "dirs": [{"name": r, "path": r} for r in here]}
    real = resolve_folder(path, roots, strictly=False)
    if not os.path.isdir(real):
        raise FileNotFoundError(path)
    dirs, more = _dirs(real)
    is_root = any(real == os.path.realpath(r) for r in roots)
    out = {"path": real, "parent": None if is_root else os.path.dirname(real), "dirs": dirs}
    if more:
        out["truncated"] = True
    return out


def browse_inside(mountpoint: str, subpath: str) -> dict:
    """browse() for a drive: paths relative to its root ("" is the root)."""
    sub = clean_subpath(subpath)
    root = os.path.realpath(mountpoint)
    real = os.path.realpath(os.path.join(root, sub)) if sub else root
    if not _inside(real, root, strictly=False):
        raise OutsideRoots(f"{subpath} is outside the drive")
    if not os.path.isdir(real):
        raise FileNotFoundError(subpath)
    dirs, more = _dirs(real, rel_to=root)
    rel = os.path.relpath(real, root) if real != root else ""
    out = {"path": rel, "parent": os.path.dirname(rel) if rel else None, "dirs": dirs}
    if more:
        out["truncated"] = True
    return out


def clean_subpath(subpath: str) -> str:
    """A path inside a drive, relative to its root ("" is the root): no '..',
    no doubled or outer slashes."""
    if not isinstance(subpath, str):
        raise DriveError("subpath is a path inside the drive")
    parts = [p for p in subpath.split("/") if p not in ("", ".")]
    if ".." in parts:
        raise OutsideRoots(f"subpath {subpath!r} must stay inside the drive (no '..')")
    return "/".join(parts)


# ------------------------------------------------------------------- drives
def _flag(v) -> bool:
    return v in (True, 1, "1", "true")


def _mountpoint(dev: dict) -> str | None:
    mps = dev.get("mountpoints")
    if mps is None and dev.get("mountpoint"):
        mps = [dev["mountpoint"]]
    return next((m for m in (mps or []) if m), None)


def _flatten(devs: list[dict], parent: dict | None = None, out: list[dict] | None = None) -> list[dict]:
    """lsblk's tree as a list, each with its "_disk" (the top device's name)
    and the model of the disk it's on."""
    out = [] if out is None else out
    for d in devs or []:
        d = dict(d)
        d["_disk"] = parent["_disk"] if parent else d.get("name")
        d["_model"] = d.get("model") or (parent or {}).get("_model")
        out.append(d)
        _flatten(d.get("children") or [], d, out)
    return out


def parse_lsblk(text: str) -> list[dict]:
    """lsblk --json (a tree or --list) as [{uuid, label, fstype, size,
    mountpoint, removable, model}]: filesystems that could hold projects."""
    devs = _flatten(json.loads(text or "{}").get("blockdevices") or [])
    by_name = {d.get("name"): d for d in devs}

    def disk_of(d: dict) -> str:
        seen = set()
        while d.get("pkname") and d["pkname"] in by_name and d["pkname"] not in seen:
            seen.add(d["pkname"])
            d = by_name[d["pkname"]]
        return d.get("_disk") if not d.get("pkname") else d.get("name")

    def system_mount(m: str) -> bool:
        return m in SYSTEM_MOUNTS or m.startswith("/boot/")

    system = {disk_of(d) for d in devs
              if any(system_mount(m) for m in (d.get("mountpoints") or [d.get("mountpoint")]) if m)}
    out, seen = [], set()
    for d in devs:
        uuid, fstype = d.get("uuid"), d.get("fstype")
        if not uuid or not fstype or fstype in NOT_DATA or d.get("type") == "loop":
            continue
        if disk_of(d) in system or uuid in seen:
            continue
        seen.add(uuid)
        out.append({"uuid": uuid, "label": d.get("label") or "", "fstype": fstype,
                    "size": int(d.get("size") or 0), "mountpoint": _mountpoint(d),
                    "removable": _flag(d.get("rm")) or _flag(d.get("hotplug")),
                    "model": (d.get("_model") or "").strip() or None})
    return out


def mount_options(fstype: str, uid: int) -> str | None:
    return f"uid={uid},gid={uid},umask=022" if fstype in OWNERLESS else None


class Drives:
    def __init__(self, uid: int = 1000, runner: Runner = run, root: bool | None = None,
                 mountinfo: str = "/proc/self/mountinfo", by_uuid: str = "/dev/disk/by-uuid") -> None:
        self.uid = uid
        self.run = runner
        self.root = (os.geteuid() == 0) if root is None else root
        self.mountinfo = mountinfo
        self.by_uuid = by_uuid
        self._lock = asyncio.Lock()  # one mount at a time

    async def list(self) -> list[dict]:
        code, out, err = await self.run(LSBLK)
        if code != 0:
            raise DriveError(f"lsblk: {err.strip() or f'exit {code}'}")
        return parse_lsblk(out)

    async def find(self, uuid: str) -> dict | None:
        return next((d for d in await self.list() if d["uuid"] == uuid), None)

    def _mounted_by_mountinfo(self, uuid: str) -> str | None:
        """Where the kernel says /dev/disk/by-uuid/<uuid> is mounted, if lsblk
        didn't say (it reads the same table, but through its own eyes)."""
        try:
            dev = os.path.realpath(os.path.join(self.by_uuid, uuid))
            lines = Path(self.mountinfo).read_text().splitlines()
        except OSError:
            return None
        for line in lines:
            pre, _, post = line.partition(" - ")
            fields, src = pre.split(), post.split()
            if len(fields) > 4 and len(src) > 1 and os.path.realpath(src[1]) == dev:
                return fields[4].replace("\\040", " ")
        return None

    async def where(self, uuid: str) -> tuple[dict | None, str | None]:
        """(the drive, where it's mounted): (None, None) when it isn't here."""
        drive = await self.find(uuid)
        if drive is None:
            return None, None
        return drive, drive["mountpoint"] or self._mounted_by_mountinfo(uuid)

    async def mount(self, uuid: str, label: str = "", fstype: str = "") -> str:
        """Where the drive is mounted, mounting it first when it isn't."""
        if not UUID_RE.match(uuid or ""):
            raise DriveError(f"bad drive id {uuid!r}")
        async with self._lock:
            drive, mp = await self.where(uuid)
            if drive is None:
                raise DriveMissing(f"plug in the drive {label or uuid}")
            if mp:
                return mp
            dev = f"{self.by_uuid}/{uuid}"
            if self.root:
                target = f"{DRIVES_DIR}/{uuid}"
                argv = ["systemd-mount", "--no-block", "--collect"]
                if opts := mount_options(drive["fstype"] or fstype, self.uid):
                    argv += ["-o", opts]
                code, out, err = await self.run([*argv, dev, target])
                if code != 0:
                    raise DriveError(f"mounting {label or uuid}: {err.strip() or out.strip() or f'exit {code}'}")
                return await self._wait(uuid, label)
            code, out, err = await self.run(["udisksctl", "mount", "-b", dev, "--no-user-interaction"])
            if code != 0:
                raise DriveError(f"mounting {label or uuid}: {err.strip() or out.strip() or f'exit {code}'}")
            m = UDISKS_RE.search(out)
            if m:
                return m.group(1)
            return await self._wait(uuid, label)

    async def _wait(self, uuid: str, label: str) -> str:
        """systemd-mount --no-block returns before the mount is there."""
        end = time.monotonic() + MOUNT_WAIT_S
        while True:
            _, mp = await self.where(uuid)
            if mp:
                log.info("mounted drive %s at %s", label or uuid, mp)
                return mp
            if time.monotonic() > end:
                raise DriveError(f"{label or uuid} didn't get mounted")
            await asyncio.sleep(0.3)
