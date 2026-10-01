"""Launches: /api/launches with a fake podman, systemd and git."""
import asyncio
import json
import shutil
import time

import pytest
from fastapi.testclient import TestClient

from wadd import launches as launches_mod
from wadd import manager as manager_mod
from wadd.api import create_app
from wadd.config import parse_config
from wadd.kiosk import NullKiosk
from wadd.manager import WorkspaceManager
from wadd.projects import setup_hash
from test_gitops import Remote, commit, run
from test_manager import FakeBackend

IMAGE = "localhost/wadspaces-a:latest"
LABELLED = {"io.wadspaces.projects": "1"}


class FakePodman:
    def __init__(self, root):
        self.labels = {IMAGE: dict(LABELLED)}
        self.volumes = {"wad-a-config": str(root / "volumes" / "wad-a-config" / "_data")}
        self.label_gate = None  # an asyncio.Event image_labels waits on

    async def image_labels(self, ref):
        if self.label_gate is not None:
            await asyncio.wait_for(self.label_gate.wait(), 5)
        return self.labels.get(ref)

    async def image_exists(self, ref):
        return ref in self.labels

    async def volume_mountpoint(self, name):
        return self.volumes.get(name)

    async def secret_value(self, name):
        return "ghp_" + "T" * 36


class Backend(FakeBackend):
    name = "systemd"

    def __init__(self, root):
        super().__init__()
        self.api = FakePodman(root)

    async def daemon_reload(self):
        self.calls.append(("daemon-reload",))


class FakeGit:
    def __init__(self):
        self.calls = []
        self.started = None  # set when a clone begins
        self.slow = False

    async def clone(self, url, ref, dest, token=None, on_line=None, *, uid=None, prepare=None):
        self.calls.append({"url": url, "ref": ref, "dest": dest, "token": token, "uid": uid})
        if self.started is not None:
            self.started.set()
        on_line("Cloning into 'x.part'...", None)
        on_line("Receiving objects:  50% (1/2)", 0.5)
        if self.slow:
            await asyncio.sleep(30)
        dest.mkdir()
        (dest / "README.md").write_text("cloned")
        on_line("Receiving objects: 100% (2/2), done.", 1.0)


@pytest.fixture
def env(tmp_path, monkeypatch):
    async def instant(url, timeout, interval=1.0):
        return None
    monkeypatch.setattr(manager_mod, "wait_http_ok", instant)
    git = FakeGit()
    monkeypatch.setattr(launches_mod.gitimport, "clone", git.clone)
    cfg = parse_config({"daemon": {"state_dir": str(tmp_path / "state"), "projects_dir": str(tmp_path / "projects"),
                                   "quadlet_dir": str(tmp_path / "units")},
                        "workspaces": [{"id": "a", "name": "A", "image": IMAGE, "port": 3100,
                                        "volumes": ["wad-a-config:/config:z"]},
                                       {"id": "b", "name": "B", "image": IMAGE, "port": 3101}]},
                       tmp_path / "w.yaml")
    mgr = WorkspaceManager(cfg, Backend(tmp_path), NullKiosk())
    events = []
    publish = mgr.bus.publish
    mgr.bus.publish = lambda ev: (events.append(ev), publish(ev))
    mgr.projects.put("vault", {"name": "Vault", "mountName": "Writing", "setup": "npm install",
                               "source": {"kind": "git", "url": "https://github.com/o/vault.git", "ref": "main"}})
    mgr.projects.put("notes", {"name": "Notes", "mountName": "Notes",
                               "source": {"kind": "git", "url": "https://github.com/o/notes"}})
    with TestClient(create_app(mgr)) as c:
        yield c, mgr, git, events, tmp_path


def wait_for(c, job_id, statuses=("done", "error", "cancelled"), timeout=5):
    end = time.time() + timeout
    while time.time() < end:
        job = c.get(f"/api/launches/{job_id}").json()
        if job["status"] in statuses:
            return job
        time.sleep(0.03)
    raise AssertionError(f"launch stuck: {job}")


def test_launch_with_projects(env):
    c, mgr, git, events, tmp = env
    r = c.post("/api/launches", json={"workspace": "a", "projects": ["vault", "notes"]})
    assert r.status_code == 201, r.text
    job = wait_for(c, r.json()["id"])
    assert job["status"] == "done", job
    assert job["progress"] == 1.0 and job["view"] == "stream"
    assert [(p["key"], p["state"]) for p in job["parts"]] == [("image", "done"), ("vault", "done"), ("notes", "done")]
    # Both were cloned (with the token, as uid 1000).
    token = "ghp_" + "T" * 36
    assert git.calls == [{"url": "https://github.com/o/vault.git", "ref": "main", "dest": tmp / "projects" / "vault",
                          "token": token, "uid": 1000},
                         {"url": "https://github.com/o/notes", "ref": None, "dest": tmp / "projects" / "notes",
                          "token": token, "uid": 1000}]
    assert (tmp / "projects" / "vault" / "README.md").exists() and (tmp / "projects" / "notes").is_dir()
    manifest = json.loads((tmp / "state" / "extra" / "a" / "projects.json").read_text())
    assert manifest == {"version": 1, "projects": [
        {"id": "vault", "name": "Vault", "mount": "Writing", "setup": "npm install", "setupHash": setup_hash("npm install")},
        {"id": "notes", "name": "Notes", "mount": "Notes", "setup": "", "setupHash": setup_hash("")}]}
    # The workspace mounts them now: YAML, unit, daemon-reload; then it's up and on screen.
    projects = [{"id": "vault", "mount": "Writing"}, {"id": "notes", "mount": "Notes"}]
    assert mgr.cfg.workspace("a").projects == projects
    assert "projects:" in (tmp / "w.yaml").read_text()
    unit = (tmp / "units" / "wad-a.container").read_text()
    assert f"Volume={tmp}/projects/vault:/config/Desktop/Writing:rw,z" in unit
    assert f"Volume={tmp}/state/extra/a:/run/wadspaces-extra:ro,z" in unit
    assert mgr.backend.calls.index(("daemon-reload",)) < mgr.backend.calls.index(("start", "a"))
    assert mgr.view == "workspace:a" and mgr.states["a"].phase == "ready"
    assert mgr.runs.list("a")[0]["projects"] == ["vault", "notes"]
    assert any(e["type"] == "launch" and e["data"]["status"] == "done" for e in events)
    log = (tmp / "state" / "launches" / f"{job['id']}.log").read_text()
    assert "Receiving objects: 100% (2/2), done." in log and "50%" not in log
    # Launching again with the same projects: nothing to fetch, no unit change.
    again = wait_for(c, c.post("/api/launches", json={"workspace": "a", "projects": ["notes", "vault"]}).json()["id"])
    assert again["status"] == "done" and len(git.calls) == 2
    assert again["parts"][1]["message"] == "not a git repo — left as is"  # what the fake clone made
    assert mgr.backend.calls.count(("daemon-reload",)) == 1


def test_an_image_from_an_older_base_is_refused(env):
    c, mgr, git, _, _ = env
    mgr.podman.labels[IMAGE] = {}
    job = wait_for(c, c.post("/api/launches", json={"workspace": "a", "projects": ["notes"]}).json()["id"])
    assert job["status"] == "error"
    assert job["error"] == "this image was built on an older base; rebuild it to use projects"
    assert mgr.cfg.workspace("a").projects == [] and ("start", "a") not in mgr.backend.calls
    # Without projects that image is fine.
    assert wait_for(c, c.post("/api/launches", json={"workspace": "a"}).json()["id"])["status"] == "done"


def test_a_missing_local_image_says_build_it(env):
    c, mgr, _, _, _ = env
    mgr.podman.labels = {}
    job = wait_for(c, c.post("/api/launches", json={"workspace": "a", "projects": ["notes"]}).json()["id"])
    assert job["status"] == "error" and "build A in Wad Creator" in job["error"]
    assert job["parts"][0]["state"] == "error"


def test_an_old_clone_in_the_config_volume_is_moved_over(env):
    c, mgr, git, _, tmp = env
    old = tmp / "volumes" / "wad-a-config" / "_data" / "Desktop" / "Writing"
    old.mkdir(parents=True)
    (old / "draft.md").write_text("uncommitted work")
    job = wait_for(c, c.post("/api/launches", json={"workspace": "a", "projects": ["vault"]}).json()["id"])
    assert job["status"] == "done", job
    assert (tmp / "projects" / "vault" / "draft.md").read_text() == "uncommitted work"
    assert not old.exists() and git.calls == []
    assert any("changes kept" in line for line in job["lines"])


def test_image_and_projects_are_fetched_at_once(env):
    c, mgr, git, _, _ = env

    async def arm():
        # The image check waits for a clone to start: done one after the
        # other, this launch would time out.
        git.started = asyncio.Event()
        mgr.podman.label_gate = git.started
    c.portal.call(arm)
    assert mgr.podman.label_gate is not None
    job = wait_for(c, c.post("/api/launches", json={"workspace": "a", "projects": ["vault"]}).json()["id"])
    assert job["status"] == "done", job


def test_cancel_stops_a_clone(env):
    c, mgr, git, _, tmp = env
    git.slow = True
    job = c.post("/api/launches", json={"workspace": "a", "projects": ["vault"]}).json()
    wait_for(c, job["id"], statuses=("running",))
    while not git.calls:
        time.sleep(0.02)
    assert c.delete(f"/api/launches/{job['id']}").json()["status"] == "cancelled"
    done = wait_for(c, job["id"])
    assert done["status"] == "cancelled" and done["lines"][-1] == "✗ cancelled"
    assert mgr.cfg.workspace("a").projects == [] and ("start", "a") not in mgr.backend.calls


def test_running_with_other_projects_needs_restart(env):
    c, mgr, _, _, _ = env
    mgr.backend.running.add("a")
    mgr.states["a"].container = "running"
    r = c.post("/api/launches", json={"workspace": "a", "projects": ["notes"]})
    assert r.status_code == 409 and "running with other projects; pass restart" in r.json()["detail"]
    job = wait_for(c, c.post("/api/launches", json={"workspace": "a", "projects": ["notes"],
                                                    "restart": True}).json()["id"])
    assert job["status"] == "done", job
    calls = mgr.backend.calls
    assert calls.index(("stop", "a")) < calls.index(("daemon-reload",)) < calls.index(("start", "a"))
    # Running with the same projects: no restart needed.
    assert c.post("/api/launches", json={"workspace": "a", "projects": ["notes"]}).status_code == 201


def test_bad_requests(env):
    c, mgr, git, _, _ = env
    assert c.post("/api/launches", json={"workspace": "nope"}).status_code == 404
    assert c.post("/api/launches", json={"workspace": "a", "projects": ["nope"]}).status_code == 422
    assert c.post("/api/launches", json={"workspace": "a", "view": "tv"}).status_code == 422
    r = c.post("/api/launches", json={"workspace": "a", "view": "screen"})
    assert r.status_code == 409 and "isn't possible yet" in r.json()["detail"]
    mgr.projects.delete("notes")
    assert c.post("/api/launches", json={"workspace": "a", "projects": ["notes"]}).status_code == 422
    git.slow = True
    first = c.post("/api/launches", json={"workspace": "a", "projects": ["vault"]}).json()
    assert c.post("/api/launches", json={"workspace": "a"}).status_code == 409  # one at a time
    assert c.post("/api/launches", json={"workspace": "b"}).status_code == 201  # others may
    c.delete(f"/api/launches/{first['id']}")
    assert c.get("/api/launches/nope").status_code == 404
    assert len(c.get("/api/launches").json()) == 2
    r = c.post("/api/launches", json={"workspace": "b"}, headers={"Origin": "https://evil.example"})
    assert r.status_code == 403


def test_the_dev_backend_cannot_mount_projects(env):
    c, mgr, _, _, _ = env
    mgr.backend.name = "podman"
    r = c.post("/api/launches", json={"workspace": "a", "projects": ["notes"]})
    assert r.status_code == 409 and "systemd" in r.json()["detail"]


def test_editing_or_rebuilding_keeps_the_projects(env):
    c, mgr, _, _, _ = env
    wait_for(c, c.post("/api/launches", json={"workspace": "a", "projects": ["notes"]}).json()["id"])
    spec = {k: v for k, v in mgr.spec_dict("a").items() if k != "projects"}
    assert c.put("/api/workspaces/a", json={**spec, "name": "A2"}).status_code == 200
    assert mgr.cfg.workspace("a").projects == [{"id": "notes", "mount": "Notes"}]
    # A launch is what changes them, to none as well.
    wait_for(c, c.post("/api/launches", json={"workspace": "a", "restart": True}).json()["id"])
    assert mgr.cfg.workspace("a").projects == []


# --------------------------------------- a copy that's here: fetch, fast-forward
@pytest.fixture
def remote(env):
    """vault already on this machine: a real clone of a bare repo in tmp_path."""
    c, mgr, git, events, tmp = env
    return Remote(tmp / "remote", tmp / "projects" / "vault")


def launch_vault(c) -> dict:
    return wait_for(c, c.post("/api/launches", json={"workspace": "a", "projects": ["vault"]}).json()["id"])


def vault_part(job) -> dict:
    return next(p for p in job["parts"] if p["key"] == "vault")


@pytest.mark.parametrize("change, message, line", [
    (None, "up to date", "Writing is up to date"),
    ("behind", "updated (2 new commits)", "Writing: updated (2 new commits)"),
    ("dirty", "uncommitted changes — left as is", "Writing has uncommitted changes; not updated"),
    ("ahead", "1 unpushed commit — left as is", "Writing has 1 unpushed commit; not updated"),
    ("no-upstream", "no upstream branch — left as is", "Writing has no upstream branch; not updated"),
])
def test_a_copy_here_is_fast_forwarded_only_when_safe(env, remote, change, message, line):
    c, mgr, git, _, tmp = env
    remote.push_new(2)
    before = remote.head(remote.project)
    if change == "dirty":
        (remote.project / "README.md").write_text("my edit")
    elif change == "ahead":
        commit(remote.project, "mine.md")
        before = remote.head(remote.project)
    elif change == "no-upstream":
        run(remote.project, "checkout", "-q", "-b", "local-only")
    elif change is None:
        run(remote.project, "pull", "-q", "--ff-only")
        before = remote.head(remote.project)
    job = launch_vault(c)
    assert job["status"] == "done", job
    assert vault_part(job)["message"] == message and vault_part(job)["state"] == "done"
    assert line in job["lines"]
    assert git.calls == []  # never re-cloned
    if change == "behind":
        assert remote.head(remote.project) == remote.head(remote.laptop)
    else:
        assert remote.head(remote.project) == before


def test_a_failed_fetch_is_a_warning_not_a_failure(env, remote):
    c, mgr, _, _, _ = env
    shutil.rmtree(remote.bare)
    job = launch_vault(c)
    assert job["status"] == "done", job
    assert vault_part(job)["message"] == "couldn't fetch — left as is"
    assert any(x.startswith("⚠ Writing: couldn't fetch (") for x in job["lines"])


def test_a_failed_clone_fails_the_launch(env, monkeypatch):
    c, mgr, git, _, _ = env

    async def broken(url, ref, dest, token=None, on_line=None, *, uid=None, prepare=None):
        raise launches_mod.gitimport.GitImportError(f"git clone {url} failed: fatal: repository not found")
    monkeypatch.setattr(launches_mod.gitimport, "clone", broken)
    job = launch_vault(c)
    assert job["status"] == "error" and "repository not found" in job["error"]
    assert vault_part(job)["state"] == "error" and ("start", "a") not in mgr.backend.calls


def test_legacy_projects_launch_only_when_here(env):
    c, mgr, git, _, tmp = env
    store = mgr.projects
    (store.root / "old.json").write_text(json.dumps({
        "id": "old", "name": "Old", "mountName": "Old", "source": {"kind": "empty"}, "ignore": [],
        "holders": {}, "folderId": "wad-old", "deleted": False, "createdAt": 1, "updatedAt": 2}))
    job = wait_for(c, c.post("/api/launches", json={"workspace": "a", "projects": ["old"]}).json()["id"])
    assert job["status"] == "error" and job["error"] == "Old: not a GitHub repo and not on this machine"
    assert git.calls == [] and not (tmp / "projects" / "old").exists()
    (tmp / "projects" / "old").mkdir(parents=True)
    job = wait_for(c, c.post("/api/launches", json={"workspace": "a", "projects": ["old"]}).json()["id"])
    assert job["status"] == "done", job
    assert job["parts"][1]["message"] == "not a git repo — left as is"


# ---------------------------------------------------------- folders and drives
STICK = "5E3F-1A2B"


@pytest.fixture
def host_folders(env):
    from wadd.drives import Drives
    from test_drives import FakeHost
    c, mgr, git, events, tmp = env
    home = tmp / "home"
    (home / "Notes").mkdir(parents=True)
    mgr.cfg.daemon.folder_roots = mgr.projects.folder_roots = [str(home)]
    mgr.projects.put("folder", {"name": "Home notes", "mountName": "HomeNotes",
                                "source": {"kind": "folder", "path": f"{home}/Notes"}})
    (tmp / "stick" / "Books").mkdir(parents=True)
    drives = FakeHost(mount_dir=tmp / "stick")
    mgr.drives = Drives(runner=drives.run, root=True)
    mgr.projects.put("drive", {"name": "Books", "mountName": "Books", "source": {
        "kind": "drive", "uuid": STICK, "label": "STICK", "fstype": "exfat", "subpath": "Books"}})
    return home, drives


def test_folder_and_drive_projects_mount_where_they_are(env, host_folders):
    c, mgr, git, _, tmp = env
    home, drives = host_folders
    (home / "Notes" / ".git").mkdir()  # a repository or not, a folder is never fetched
    job = wait_for(c, c.post("/api/launches", json={"workspace": "a", "projects": ["folder", "drive", "vault"]}).json()["id"])
    assert job["status"] == "done", job
    assert [p["message"] for p in job["parts"][1:]] == ["folder on this machine", "on the drive STICK", "on this machine"]
    assert any(call[0] == "systemd-mount" for call in drives.calls)  # the stick was mounted on the way
    assert mgr.cfg.workspace("a").projects == [
        {"id": "folder", "mount": "HomeNotes", "path": f"{home}/Notes"},
        {"id": "drive", "mount": "Books", "path": str(tmp / "stick" / "Books")},
        {"id": "vault", "mount": "Writing"}]
    unit = (tmp / "units" / "wad-a.container").read_text()
    assert f"Volume={home}/Notes:/config/Desktop/HomeNotes:rw\n" in unit
    assert f"Volume={tmp}/stick/Books:/config/Desktop/Books:rw\n" in unit
    assert f"Volume={tmp}/projects/vault:/config/Desktop/Writing:rw,z\n" in unit
    assert unit.count("SecurityLabelDisable=true") == 1
    assert [c["url"] for c in git.calls] == ["https://github.com/o/vault.git"]  # only the GitHub one is cloned
    assert "path" in (tmp / "w.yaml").read_text()


@pytest.mark.parametrize("case, error", [
    ("elsewhere", "Desk is a folder on Desk PC"),
    ("missing", "folder {home}/Notes is missing"),
    ("unplugged", "plug in the drive STICK"),
    ("no-subfolder", "folder Books is missing on STICK"),
])
def test_folder_and_drive_projects_that_arent_here(env, host_folders, case, error):
    c, mgr, git, _, tmp = env
    home, drives = host_folders
    pid = "drive" if case in ("unplugged", "no-subfolder") else "folder"
    if case == "elsewhere":
        pid = "desk"
        mgr.projects.merge([{"id": "desk", "name": "Desk", "mountName": "Desk", "updatedAt": 5, "source": {
            "kind": "folder", "machineId": "m2", "machineName": "Desk PC", "path": f"{home}/Notes"}}])
    elif case == "missing":
        (home / "Notes").rmdir()
    elif case == "unplugged":
        drives.tree["blockdevices"] = [d for d in drives.tree["blockdevices"] if d["name"] != "sdb"]
    else:
        (tmp / "stick" / "Books").rmdir()
    job = wait_for(c, c.post("/api/launches", json={"workspace": "a", "projects": [pid]}).json()["id"])
    assert job["status"] == "error" and job["error"] == error.format(home=home)
    assert job["parts"][1]["state"] == "error" and ("start", "a") not in mgr.backend.calls
