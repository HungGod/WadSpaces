"""Drives and folders on the host (wadd/drives.py), /api/drives and /api/fs/browse,
with lsblk, systemd-mount and udisksctl faked."""
import asyncio
import copy
import json
import sys

import pytest
from fastapi.testclient import TestClient

from wadd import drives as drives_mod
from wadd.api import create_app
from wadd.config import parse_config
from wadd.drives import (DRIVES_DIR, LSBLK, DriveError, DriveMissing, Drives, OutsideRoots, browse,
                         browse_inside, clean_subpath, parse_lsblk, resolve_folder)
from wadd.kiosk import NullKiosk
from wadd.manager import WorkspaceManager
from conftest import PY_FIXTURES
from test_manager import FakeBackend

LSBLK_JSON = json.loads((PY_FIXTURES / "lsblk.json").read_text())
STICK, DATA, VAULT = "5E3F-1A2B", "bbbbbbbb-0000-4000-8000-000000000001", "cccccccc-0000-4000-8000-000000000001"


def devices(tree: dict) -> list[dict]:
    out = []
    for d in tree["blockdevices"]:
        out.append(d)
        stack = list(d.get("children") or [])
        while stack:
            c = stack.pop()
            out.append(c)
            stack += c.get("children") or []
    return out


class FakeHost:
    """lsblk's answer (mutable), and what systemd-mount / udisksctl do to it."""

    def __init__(self, mount_dir=None):
        self.tree = copy.deepcopy(LSBLK_JSON)
        self.calls: list[list[str]] = []
        self.mount_dir = mount_dir  # where a mount "appears" (a real folder, for browsing)
        self.fail_mount = False
        self.lag = 0  # lsblk calls before a systemd-mount shows

    def dev(self, uuid):
        return next(d for d in devices(self.tree) if d.get("uuid") == uuid)

    def mounted(self, uuid, where):
        self.dev(uuid)["mountpoints"] = [where]

    async def run(self, argv):
        self.calls.append(argv)
        if argv == LSBLK:
            if self.lag:
                self.lag -= 1
                if not self.lag:
                    self.mounted(*self.pending)
            return 0, json.dumps(self.tree), ""
        if self.fail_mount:
            return 1, "", "Failed to mount: wrong fs type"
        uuid = argv[-1].rsplit("/", 1)[-1] if argv[0] == "systemd-mount" else argv[3].rsplit("/", 1)[-1]
        if argv[0] == "systemd-mount":
            where = str(self.mount_dir or f"{DRIVES_DIR}/{uuid}")
            if self.lag:
                self.pending = (uuid, where)
            else:
                self.mounted(uuid, where)
            return 0, f"Started unit run-wadspaces\\x2ddrives-{uuid}.mount\n", ""
        if argv[0] == "udisksctl":
            where = str(self.mount_dir or f"/run/media/wad/{self.dev(uuid)['label']}")
            self.mounted(uuid, where)
            return 0, f"Mounted /dev/sdb1 at {where}.\n", ""
        return 127, "", f"{argv[0]}: not found"


def test_lsblk_keeps_only_data_drives():
    drives = parse_lsblk(json.dumps(LSBLK_JSON))
    assert [d["uuid"] for d in drives] == [DATA, VAULT, STICK]
    # Not: the loop device, anything on the disk the system runs from (even its
    # spare partition), swap (zram too), LUKS and LVM members.
    assert drives[0] == {"uuid": DATA, "label": "Data", "fstype": "ext4", "size": 1500000000000,
                         "mountpoint": "/mnt/data", "removable": False, "model": "WDC WD20EZAZ-00G"}
    assert drives[1]["label"] == "Vault" and drives[1]["mountpoint"] is None  # unlocked, inside LUKS
    assert drives[2] == {"uuid": STICK, "label": "STICK", "fstype": "exfat", "size": 64022208512,
                         "mountpoint": None, "removable": True, "model": "SanDisk Ultra"}


def test_lsblk_list_form_and_old_style_values():
    # `lsblk --list`, and older lsblk: strings for numbers and flags, one mountpoint.
    flat = {"blockdevices": [
        {"name": "sda", "uuid": None, "fstype": None, "size": "100", "type": "disk", "pkname": None,
         "model": "Disk", "rm": "0", "hotplug": "0", "mountpoint": None},
        {"name": "sda1", "uuid": "U1", "fstype": "ext4", "size": "90", "type": "part", "pkname": "sda",
         "rm": "0", "hotplug": "1", "mountpoint": "/run/media/wad/x"},
        {"name": "sdc", "uuid": None, "fstype": None, "size": "100", "type": "disk", "pkname": None},
        {"name": "sdc1", "uuid": "SYS", "fstype": "xfs", "size": "9", "type": "part", "pkname": "sdc", "mountpoint": "/"},
        {"name": "sdc2", "uuid": "SYS2", "fstype": "xfs", "size": "9", "type": "part", "pkname": "sdc"}]}
    assert parse_lsblk(json.dumps(flat)) == [{"uuid": "U1", "label": "", "fstype": "ext4", "size": 90,
                                              "mountpoint": "/run/media/wad/x", "removable": True, "model": None}]
    assert parse_lsblk("") == []


def test_an_unmounted_drive_is_mounted_by_systemd_as_root():
    host = FakeHost()
    d = Drives(uid=1000, runner=host.run, root=True)
    assert asyncio.run(d.mount(STICK, "STICK")) == f"{DRIVES_DIR}/{STICK}"
    # FAT-like filesystems have no owners: they are mounted as the projects user.
    assert ["systemd-mount", "--no-block", "--collect", "-o", "uid=1000,gid=1000,umask=022",
            f"/dev/disk/by-uuid/{STICK}", f"{DRIVES_DIR}/{STICK}"] in host.calls
    assert asyncio.run(d.mount(VAULT, "Vault")) == f"{DRIVES_DIR}/{VAULT}"
    assert ["systemd-mount", "--no-block", "--collect", f"/dev/disk/by-uuid/{VAULT}",
            f"{DRIVES_DIR}/{VAULT}"] in host.calls  # xfs: as it is


def test_systemd_mount_returns_before_the_mount_is_there():
    host = FakeHost()
    host.lag = 3
    d = Drives(runner=host.run, root=True)
    assert asyncio.run(d.mount(STICK)) == f"{DRIVES_DIR}/{STICK}"
    assert sum(c == LSBLK for c in host.calls) >= 3


def test_a_user_wadd_mounts_with_udisks():
    host = FakeHost()
    d = Drives(runner=host.run, root=False)
    assert asyncio.run(d.mount(STICK, "STICK")) == "/run/media/wad/STICK"
    assert ["udisksctl", "mount", "-b", f"/dev/disk/by-uuid/{STICK}", "--no-user-interaction"] in host.calls


def test_already_mounted_and_missing_drives(tmp_path):
    host = FakeHost()
    d = Drives(runner=host.run, root=True)
    assert asyncio.run(d.mount(DATA)) == "/mnt/data"
    assert [c[0] for c in host.calls] == ["lsblk"]  # nothing to mount
    with pytest.raises(DriveMissing, match="plug in the drive Backup"):
        asyncio.run(d.mount("ffffffff-0000-4000-8000-000000000009", "Backup"))
    with pytest.raises(DriveError, match="bad drive id"):
        asyncio.run(d.mount("../etc"))
    host.fail_mount = True
    with pytest.raises(DriveError, match="mounting STICK: Failed to mount"):
        asyncio.run(d.mount(STICK, "STICK"))


def test_mountinfo_is_asked_when_lsblk_shows_no_mountpoint(tmp_path):
    by_uuid = tmp_path / "by-uuid"
    by_uuid.mkdir()
    (tmp_path / "sdb1").write_text("")
    (by_uuid / STICK).symlink_to(tmp_path / "sdb1")
    mountinfo = tmp_path / "mountinfo"
    mountinfo.write_text(f"36 35 8:1 / /run/media/wad/MY\\040STICK rw,relatime shared:1 - exfat {tmp_path}/sdb1 rw\n")
    host = FakeHost()
    d = Drives(runner=host.run, root=True, mountinfo=str(mountinfo), by_uuid=str(by_uuid))
    assert asyncio.run(d.mount(STICK)) == "/run/media/wad/MY STICK"


def test_the_real_runner(tmp_path, monkeypatch):
    fake = tmp_path / "lsblk"
    fake.write_text(f"#!{sys.executable}\nimport sys\nprint(open({str(PY_FIXTURES / 'lsblk.json')!r}).read())\n")
    fake.chmod(0o755)
    monkeypatch.setenv("PATH", f"{tmp_path}:/usr/bin:/bin")
    assert [x["label"] for x in asyncio.run(Drives().list())] == ["Data", "Vault", "STICK"]
    assert asyncio.run(drives_mod.run(["no-such-command-here"]))[0] == 127


# ------------------------------------------------------------------ folders
@pytest.fixture
def roots(tmp_path):
    home, media = tmp_path / "home", tmp_path / "media"
    for d in ("wad/Notes/drafts", "wad/Notes/.git", "wad/Code", "wad/.cache", "other"):
        (home / d).mkdir(parents=True)
    (home / "wad" / "file.txt").write_text("x")
    media.mkdir()
    (home / "wad" / "escape").symlink_to(tmp_path)
    return [str(home), str(media), str(tmp_path / "absent")], home


def test_resolve_folder(roots):
    rs, home = roots
    assert resolve_folder(f"{home}/wad/Notes", rs) == f"{home}/wad/Notes"
    assert resolve_folder(f"{home}/wad/../wad/Notes", rs) == f"{home}/wad/Notes"
    with pytest.raises(OutsideRoots):
        resolve_folder(str(home), rs)  # a root itself
    assert resolve_folder(str(home), rs, strictly=False) == str(home)
    for bad in ("/etc", f"{home}/wad/escape", f"{home}/../", "relative", f"{home}x/y"):
        with pytest.raises(OutsideRoots):
            resolve_folder(bad, rs)


def test_browse(roots, monkeypatch):
    rs, home = roots
    top = browse(None, rs)
    assert top == {"path": None, "parent": None, "dirs": [{"name": rs[0], "path": rs[0]},
                                                          {"name": rs[1], "path": rs[1]}]}  # not the absent one
    b = browse(f"{home}/wad", rs)
    # Folders only, no hidden ones, sorted; the symlink out is listed but can't be opened.
    assert b == {"path": f"{home}/wad", "parent": str(home), "dirs": [
        {"name": "Code", "path": f"{home}/wad/Code"}, {"name": "escape", "path": f"{home}/wad/escape"},
        {"name": "Notes", "path": f"{home}/wad/Notes"}]}
    assert browse(str(home), rs)["parent"] is None
    with pytest.raises(OutsideRoots):
        browse(f"{home}/wad/escape", rs)
    with pytest.raises(FileNotFoundError):
        browse(f"{home}/wad/nope", rs)
    monkeypatch.setattr(drives_mod, "MAX_DIRS", 2)
    assert len(browse(f"{home}/wad", rs)["dirs"]) == 2 and browse(f"{home}/wad", rs)["truncated"]


def test_browse_inside_a_drive(tmp_path):
    (tmp_path / "drive" / "Books" / "Novel").mkdir(parents=True)
    (tmp_path / "drive" / "Music").mkdir()
    drive = str(tmp_path / "drive")
    assert browse_inside(drive, "") == {"path": "", "parent": None, "dirs": [
        {"name": "Books", "path": "Books"}, {"name": "Music", "path": "Music"}]}
    assert browse_inside(drive, "/Books/") == {"path": "Books", "parent": "",
                                               "dirs": [{"name": "Novel", "path": "Books/Novel"}]}
    assert browse_inside(drive, "Books/Novel")["parent"] == "Books"
    with pytest.raises(DriveError):
        browse_inside(drive, "../..")
    assert clean_subpath("a//b/./c/") == "a/b/c" and clean_subpath("") == ""


# ------------------------------------------------------------------- API
@pytest.fixture
def api(tmp_path, roots):
    rs, home = roots
    cfg = parse_config({"daemon": {"state_dir": str(tmp_path / "state"), "projects_dir": str(tmp_path / "projects"),
                                   "folder_roots": rs},
                        "workspaces": [{"id": "a", "name": "A", "image": "i", "port": 3100}]},
                       tmp_path / "w.yaml")
    mgr = WorkspaceManager(cfg, FakeBackend(), NullKiosk())
    (tmp_path / "stick" / "Novel").mkdir(parents=True)
    host = FakeHost(mount_dir=tmp_path / "stick")
    mgr.drives = Drives(runner=host.run, root=True)
    return TestClient(create_app(mgr)), mgr, host, home


def test_api_drives_and_browse(api):
    c, mgr, host, home = api
    assert [d["label"] for d in c.get("/api/drives").json()] == ["Data", "Vault", "STICK"]
    assert c.get("/api/fs/browse").json()["dirs"][0]["path"].endswith("home")
    assert [d["name"] for d in c.get("/api/fs/browse", params={"path": f"{home}/wad"}).json()["dirs"]] == \
        ["Code", "escape", "Notes"]
    assert c.get("/api/fs/browse", params={"path": "/etc"}).status_code == 403
    assert c.get("/api/fs/browse", params={"path": f"{home}/nope"}).status_code == 404
    # A drive: mounted on the way, and paths inside it.
    r = c.get("/api/fs/browse", params={"drive": STICK})
    assert r.json() == {"path": "", "parent": None, "dirs": [{"name": "Novel", "path": "Novel"}]}
    assert any(call[0] == "systemd-mount" for call in host.calls)
    assert c.get("/api/fs/browse", params={"drive": STICK, "path": "../.."}).status_code == 403
    r = c.get("/api/fs/browse", params={"drive": "ffffffff-0000-4000-8000-000000000009"})
    assert r.status_code == 409 and r.json()["detail"].startswith("plug in the drive")
    assert c.get("/api/fs/browse", params={"drive": "x y"}).status_code == 422


def test_api_drives_without_lsblk(api):
    c, mgr, host, _ = api

    async def broken(argv):
        return 127, "", "lsblk is not installed"
    mgr.drives.run = broken
    r = c.get("/api/drives")
    assert r.status_code == 503 and "lsblk is not installed" in r.json()["detail"]
