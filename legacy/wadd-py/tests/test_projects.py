"""Projects: the store (projects.py) and /api/projects."""
import json

import pytest
from fastapi.testclient import TestClient

from wadd.api import create_app
from wadd.config import parse_config
from wadd.kiosk import NullKiosk
from wadd.manager import WorkspaceManager
from wadd.projects import (ProjectConflict, ProjectError, ProjectStore, mount_for, new_id, setup_hash,
                           write_manifest)
from test_manager import FakeBackend


def gh(repo: str) -> dict:
    return {"kind": "git", "url": f"https://github.com/o/{repo}.git"}


NOTES = {"name": "Notes", "mountName": "Notes", "source": gh("notes")}
VAULT = {"name": "Writing vault", "mountName": "Writing", "setup": "npm install",
         "source": {"kind": "git", "url": "https://github.com/o/vault.git", "ref": "main"}}


@pytest.fixture
def store(tmp_path):
    return ProjectStore(tmp_path / "projects")


def test_new_ids_look_like_firestore_auto_ids():
    ids = {new_id() for _ in range(50)}
    assert len(ids) == 50 and all(len(i) == 20 and i.isalnum() for i in ids)


def test_put_fills_in_defaults_and_get_list(store):
    doc = store.put("p1", NOTES)
    assert set(doc) == {"id", "name", "mountName", "source", "setup", "deleted", "createdAt", "updatedAt",
                        "synced"}
    assert doc["source"] == gh("notes") and doc["setup"] == "" and doc["deleted"] is False
    assert doc["createdAt"] == doc["updatedAt"] and doc["synced"] is False
    assert store.get("p1") == doc and store.list() == [doc]
    with pytest.raises(KeyError):
        store.get("nope")


def test_update_keeps_created_and_moves_updated_on(store):
    first = store.put("p1", VAULT)
    again = store.put("p1", {**VAULT, "setup": "make", "createdAt": 1, "updatedAt": 1, "folderId": "x",
                             "holders": {"m": {}}, "ignore": ["x"]})
    assert again["createdAt"] == first["createdAt"] and again["updatedAt"] > first["updatedAt"]
    assert again["setup"] == "make"  # the store owns the timestamps; the old fields are dropped
    assert not {"folderId", "holders", "ignore"} & set(again)
    assert store.changes == 2


@pytest.mark.parametrize("body, msg", [
    ({"mountName": "A", "source": gh("a")}, "name"),
    ({"name": "A", "mountName": "a/b", "source": gh("a")}, "mountName"),
    ({"name": "A", "mountName": "..", "source": gh("a")}, "mountName"),
    ({"name": "A", "mountName": "A"}, "^a project is a GitHub repo, a folder or a drive$"),
    ({"name": "A", "mountName": "A", "source": {"kind": "empty"}}, "^a project is a GitHub repo, a folder or a drive$"),
    ({"name": "A", "mountName": "A", "source": {"kind": "local"}}, "^a project is a GitHub repo, a folder or a drive$"),
    ({"name": "A", "mountName": "A", "source": "https://github.com/o/r"}, "^a project is a GitHub repo, a folder or a drive$"),
    ({"name": "A", "mountName": "A", "source": {"kind": "git", "url": "http://github.com/o/r"}}, "GitHub repo"),
    ({"name": "A", "mountName": "A", "source": {"kind": "git", "url": "git@github.com:o/r.git"}}, "GitHub repo"),
    ({"name": "A", "mountName": "A", "source": {"kind": "git", "url": "https://gitlab.com/o/r"}}, "GitHub repo"),
    ({"name": "A", "mountName": "A", "source": {"kind": "git", "url": "https://github.com/o"}}, "GitHub repo"),
    ({"name": "A", "mountName": "A", "source": {"kind": "git", "url": "https://github.com/o/r/tree/x"}}, "GitHub"),
    ({"name": "A", "mountName": "A", "source": {"kind": "git", "url": "file:///etc"}}, "GitHub repo"),
    ({"name": "A", "mountName": "A", "source": {**gh("r"), "ref": "--upload-pack=x"}}, "ref"),
    ({"name": "A", "mountName": "A", "source": gh("r"), "setup": ["make"]}, "setup"),
])
def test_validation(store, body, msg):
    with pytest.raises(ProjectError, match=msg):
        store.put("p1", body)


def test_github_urls(store):
    for url, kept in (("https://github.com/o/r.git", "https://github.com/o/r.git"),
                      ("https://github.com/o-x/r.y_z", "https://github.com/o-x/r.y_z"),
                      ("https://github.com/o/r/", "https://github.com/o/r")):  # a trailing slash goes
        assert store.put("p1", {**NOTES, "source": {"kind": "git", "url": url}})["source"]["url"] == kept
    with pytest.raises(ProjectError):
        store.put("bad id", NOTES)


def test_old_documents_still_load_marked_legacy(store):
    store.root.mkdir(parents=True)
    (store.root / "old.json").write_text(json.dumps({
        "id": "old", "name": "Old", "mountName": "Old", "source": {"kind": "empty"}, "setup": "",
        "ignore": ["node_modules"], "folderId": "wad-old", "holders": {"m1": {}}, "deleted": False,
        "createdAt": 1, "updatedAt": 2, "synced": True}))
    (store.root / "ssh.json").write_text(json.dumps({
        "id": "ssh", "name": "Ssh", "mountName": "Ssh", "source": {"kind": "git", "url": "git@github.com:o/r"},
        "deleted": False, "createdAt": 1, "updatedAt": 2}))
    store.put("new", NOTES)
    old = store.get("old")
    assert old["legacy"] is True and not {"ignore", "folderId", "holders"} & set(old)
    assert store.get("ssh")["legacy"] is True and "legacy" not in store.get("new")
    assert [d.get("legacy", False) for d in store.list()] == [False, True, True]  # Notes, Old, Ssh
    # Saving one makes it a GitHub repo like any other.
    with pytest.raises(ProjectError, match="GitHub repo"):
        store.put("old", {"name": "Old", "mountName": "Old", "source": {"kind": "empty"}})
    assert "legacy" not in store.put("old", {"name": "Old", "mountName": "Old", "source": gh("old")})
    assert "legacy" not in json.loads((store.root / "old.json").read_text())


def test_mount_for_repo_names():
    assert mount_for("my-repo.v2") == "my-repo.v2" and mount_for("a b/c") == "a-b-c"
    assert mount_for("..") == "project" and mount_for("") == "project" and len(mount_for("x" * 100)) == 64


def test_mount_names_are_unique_among_live_projects(store):
    store.put("p1", NOTES)
    with pytest.raises(ProjectConflict, match="Notes"):
        store.put("p2", {**NOTES, "name": "Other"})
    store.put("p1", {**NOTES, "name": "Renamed"})  # itself is fine
    store.delete("p1")
    assert store.put("p2", {**NOTES, "name": "Other"})["mountName"] == "Notes"


def test_delete_is_a_tombstone(store):
    doc = store.put("p1", NOTES)
    gone = store.delete("p1")
    assert gone["deleted"] is True and gone["updatedAt"] > doc["updatedAt"]
    assert store.list() == [] and store.list(include_deleted=True) == [gone]
    assert store.delete("p1") == gone  # again: nothing changes
    assert store.put("p1", NOTES)["deleted"] is False  # saving brings it back


def test_merge_newest_wins_both_ways(store):
    mine = store.put("mine", NOTES)
    older = store.put("older", {"name": "Old here", "mountName": "Old", "source": gh("old")})
    newer = store.put("newer", {"name": "New here", "mountName": "New", "source": gh("new")})
    remote = [
        {**older, "name": "Changed online", "updatedAt": older["updatedAt"] + 1000,
         "holders": {"m2": {"state": "idle"}}, "ignore": ["x"], "folderId": "wad-older"},
        {**newer, "name": "Stale online", "updatedAt": newer["updatedAt"] - 1000},
        {"id": "theirs", "name": "Made online", "mountName": "Online", "source": gh("online"),
         "updatedAt": 5, "createdAt": 4},
        {"id": "empty", "name": "Old kind", "mountName": "Empty", "source": {"kind": "empty"}, "updatedAt": 5},
    ]
    push = store.merge(remote)
    assert sorted(d["id"] for d in push) == ["mine", "newer"]  # never sent + newer here
    assert store.get("older")["name"] == "Changed online" and store.get("older")["synced"]
    assert not {"holders", "ignore", "folderId"} & set(store.get("older"))  # dropped on the way in
    assert store.get("newer")["name"] == "New here"
    theirs = store.get("theirs")
    assert theirs["synced"] and theirs["source"] == gh("online") and theirs["updatedAt"] == 5
    assert store.get_or_none("empty") is None  # not a GitHub repo: not taken in
    assert store.changes == 3  # what a sync brings in isn't a local change
    store.mark_synced(["mine", "newer"])
    assert store.get("mine")["synced"] and mine["id"] == "mine"


def test_merge_takes_remote_tombstones_and_outright_deletes(store):
    a = store.put("a", NOTES)
    store.put("b", {"name": "B", "mountName": "B", "source": gh("b")})
    store.mark_synced(["a", "b"])
    store.put("c", {"name": "C", "mountName": "C", "source": gh("c")})  # never synced: offline-made, goes up
    push = store.merge([{"id": "a", "deleted": True, "updatedAt": a["updatedAt"] + 1}])
    assert store.get("a")["deleted"] and store.get("a")["name"] == "Notes"
    assert store.get("b")["deleted"]  # the cloud knew it and dropped it: deleted online
    assert [d["id"] for d in push] == ["c"]


def test_legacy_projects_are_never_pushed(store):
    store.root.mkdir(parents=True)
    (store.root / "old.json").write_text(json.dumps({
        "id": "old", "name": "Old", "mountName": "Old", "source": {"kind": "local"}, "holders": {},
        "deleted": False, "createdAt": 1, "updatedAt": 2}))
    store.put("new", NOTES)
    assert [d["id"] for d in store.merge([])] == ["new"]


def test_manifest_is_written_atomically_with_setup_hashes(tmp_path):
    path = write_manifest(tmp_path, "writing", [
        {"id": "p1", "name": "Vault", "mount": "Writing", "setup": "npm install"},
        {"id": "p2", "name": "Notes", "mount": "Notes", "setup": ""}])
    assert path == tmp_path / "extra" / "writing" / "projects.json"
    data = json.loads(path.read_text())
    assert data == {"version": 1, "projects": [
        {"id": "p1", "name": "Vault", "mount": "Writing", "setup": "npm install",
         "setupHash": setup_hash("npm install")},
        {"id": "p2", "name": "Notes", "mount": "Notes", "setup": "", "setupHash": setup_hash("")}]}
    assert len(setup_hash("npm install")) == 12 and setup_hash("a") != setup_hash("b")
    assert [p.name for p in path.parent.iterdir()] == ["projects.json"]  # no temp file left


# ------------------------------------------------------------------- API
@pytest.fixture
def api(tmp_path):
    cfg = parse_config({"daemon": {"state_dir": str(tmp_path / "state"),
                                   "projects_dir": str(tmp_path / "projects")},
                        "workspaces": [{"id": "a", "name": "A", "image": "i", "port": 3100}]},
                       tmp_path / "w.yaml")
    mgr = WorkspaceManager(cfg, FakeBackend(), NullKiosk())
    events = []
    mgr.bus.publish = events.append
    return TestClient(create_app(mgr)), mgr, events, tmp_path


def test_api_crud(api):
    c, mgr, events, _ = api
    made = c.post("/api/projects", json=NOTES)
    assert made.status_code == 201
    pid = made.json()["id"]
    assert len(pid) == 20 and events[-1] == {"type": "projects", "data": {"ids": [pid]}}
    assert c.put("/api/projects/vault1", json=VAULT).json()["source"]["ref"] == "main"
    assert [p["id"] for p in c.get("/api/projects").json()] == [pid, "vault1"]
    assert c.get("/api/projects/vault1").json()["setup"] == "npm install"
    assert c.get("/api/projects/nope").status_code == 404
    assert c.put("/api/projects/x2", json={**NOTES, "name": "Clash"}).status_code == 409
    assert c.put("/api/projects/x2", json={"name": "Bad"}).status_code == 422
    r = c.put("/api/projects/x2", json={**NOTES, "mountName": "X2", "source": {"kind": "empty"}})
    assert r.status_code == 422 and r.json()["detail"] == "a project is a GitHub repo, a folder or a drive"
    r = c.post("/api/projects", json={**NOTES, "mountName": "X2", "source": {"kind": "local"}})
    assert r.status_code == 422 and r.json()["detail"] == "a project is a GitHub repo, a folder or a drive"
    assert c.delete(f"/api/projects/{pid}").json()["deleted"] is True
    assert [p["id"] for p in c.get("/api/projects").json()] == ["vault1"]
    assert len(c.get("/api/projects?deleted=1").json()) == 2
    assert c.put("/api/projects/x2", json=NOTES, headers={"Origin": "https://evil.example"}).status_code == 403


def test_api_status_and_purge(api):
    c, mgr, _, tmp = api
    c.put("/api/projects/p1", json=NOTES)
    st = c.get("/api/projects/p1/status").json()
    assert st == {"exists_on_disk": False, "path": str(tmp / "projects" / "p1"), "bytes": None, "mounted_in": [],
                  "git": None, "available": True}
    (tmp / "projects" / "p1").mkdir(parents=True)
    (tmp / "projects" / "p1" / "a.md").write_text("x")
    mgr.cfg.workspaces[0].projects = [{"id": "p1", "mount": "Notes"}]
    assert c.get("/api/projects/p1/status").json()["mounted_in"] == ["a"]
    r = c.delete("/api/projects/p1?purge=1")
    assert r.status_code == 409 and "mounted in a" in r.json()["detail"]
    assert (tmp / "projects" / "p1" / "a.md").exists() and not mgr.projects.get("p1")["deleted"]
    mgr.cfg.workspaces[0].projects = []
    r = c.delete("/api/projects/p1?purge=1").json()
    assert r["deleted"] and r["purged"] and not (tmp / "projects" / "p1").exists()
    assert c.get("/api/projects/nope/status").status_code == 404


def test_api_status_has_the_git_state(api):
    from test_gitops import Remote, commit
    c, mgr, _, tmp = api
    c.put("/api/projects/p1", json=NOTES)
    remote = Remote(tmp / "remote", tmp / "projects" / "p1")
    st = c.get("/api/projects/p1/status").json()
    assert st["exists_on_disk"] and st["available"]
    assert st["git"] == {"branch": "main", "dirty": False, "ahead": 0, "behind": 0, "upstream": "origin/main"}
    commit(remote.project, "mine.md")
    (remote.project / "x.md").write_text("new")
    assert c.get("/api/projects/p1/status").json()["git"] == {
        "branch": "main", "dirty": True, "ahead": 1, "behind": 0, "upstream": "origin/main"}


# ------------------------------------------------------ folders and drives
STICK = "5E3F-1A2B"


@pytest.fixture
def folders(tmp_path):
    home = tmp_path / "home"
    (home / "wad" / "Notes").mkdir(parents=True)
    (home / "wad" / "link").symlink_to(home / "wad" / "Notes")
    store = ProjectStore(tmp_path / "projects", [str(home)], lambda: ("m1", "Surface"))
    return store, home


def test_a_folder_project_is_this_machines(folders):
    store, home = folders
    doc = store.put("f1", {"name": "Notes", "mountName": "Notes",
                           "source": {"kind": "folder", "path": f"{home}/wad/link", "machineId": ""}})
    # wadd says which machine, and where the folder really is.
    assert doc["source"] == {"kind": "folder", "machineId": "m1", "machineName": "Surface",
                             "path": f"{home}/wad/Notes"}
    assert "legacy" not in doc
    for path, msg in ((f"{home}/wad/nope", "doesn't exist"), ("/etc", "isn't inside"), (str(home), "isn't inside"),
                      ("wad/Notes", "absolute")):
        with pytest.raises(ProjectError, match=msg):
            store.put("f2", {"name": "X", "mountName": "X", "source": {"kind": "folder", "path": path}})


def test_another_machines_folder_project_can_still_be_edited_here(folders):
    store, home = folders
    theirs = {"kind": "folder", "machineId": "m2", "machineName": "Desk", "path": "/var/home/wad/Elsewhere"}
    store.merge([{"id": "f9", "name": "Theirs", "mountName": "Theirs", "source": theirs, "updatedAt": 5}])
    assert store.get("f9")["source"] == theirs
    assert store.put("f9", {**store.get("f9"), "name": "Renamed"})["source"] == theirs
    resent = {**theirs, "machineId": "", "machineName": ""}  # as Wad Creator may send it back
    assert store.put("f9", {**store.get("f9"), "source": resent})["source"] == theirs
    with pytest.raises(ProjectError, match="isn't inside"):  # pointing it somewhere else is a new folder here
        store.put("f9", {**store.get("f9"), "source": {**theirs, "path": "/var/home/wad/Other"}})


def test_drive_sources(store):
    doc = store.put("d1", {"name": "Novel", "mountName": "Novel", "source": {
        "kind": "drive", "uuid": STICK, "label": "STICK", "fstype": "exfat", "subpath": "/Books//Novel/"}})
    assert doc["source"] == {"kind": "drive", "uuid": STICK, "label": "STICK", "fstype": "exfat",
                             "subpath": "Books/Novel"}
    for src, msg in (({"uuid": "a/b"}, "uuid"), ({"uuid": STICK, "subpath": "../x"}, "inside the drive"),
                     ({"uuid": STICK, "subpath": "a:b"}, "':'"), ({"uuid": STICK, "fstype": "ext 4"}, "fstype"),
                     ({"uuid": STICK, "label": ["x"]}, "label")):
        with pytest.raises(ProjectError, match=msg):
            store.put("d2", {"name": "X", "mountName": "X", "source": {"kind": "drive", **src}})


def test_folder_projects_made_before_enrolling_become_this_machines(tmp_path):
    home = tmp_path / "home"
    (home / "Notes").mkdir(parents=True)
    store = ProjectStore(tmp_path / "projects", [str(home)])
    doc = store.put("f1", {"name": "Notes", "mountName": "Notes", "source": {"kind": "folder", "path": f"{home}/Notes"}})
    assert doc["source"]["machineId"] == "local"
    changes = store.changes
    assert store.claim_local("m1", "Surface") == ["f1"]
    src = store.get("f1")["source"]
    assert src["machineId"] == "m1" and src["machineName"] == "Surface" and store.changes > changes
    assert store.get("f1")["updatedAt"] > doc["updatedAt"] and store.claim_local("m1", "Surface") == []


def test_api_status_for_folders_and_drives(api, tmp_path):
    from wadd.drives import Drives
    from test_drives import FakeHost
    c, mgr, _, tmp = api
    home = tmp / "home"
    (home / "Notes" / ".git").mkdir(parents=True)
    mgr.cfg.daemon.folder_roots = mgr.projects.folder_roots = [str(home)]
    mgr.cfg.machine_name = "Surface"
    r = c.put("/api/projects/f1", json={"name": "Notes", "mountName": "Notes",
                                        "source": {"kind": "folder", "path": f"{home}/Notes"}})
    assert r.status_code == 200 and r.json()["source"]["machineId"] == "local", r.text
    st = c.get("/api/projects/f1/status").json()
    assert st["available"] and st["exists_on_disk"] and st["path"] == f"{home}/Notes"
    assert st["git"] is None  # a .git that isn't a repository: git can't tell
    # Another machine's folder: not here.
    mgr.projects.merge([{"id": "f2", "name": "Desk", "mountName": "Desk", "updatedAt": 5, "source": {
        "kind": "folder", "machineId": "m2", "machineName": "Desk PC", "path": "/var/home/wad/D"}}])
    st = c.get("/api/projects/f2/status").json()
    assert st == {"exists_on_disk": False, "path": None, "bytes": None, "mounted_in": [], "git": None,
                  "available": False, "reason": "on Desk PC"}
    # The folder went away.
    (home / "Notes" / ".git").rmdir()
    (home / "Notes").rmdir()
    st = c.get("/api/projects/f1/status").json()
    assert not st["available"] and st["reason"] == f"folder {home}/Notes is missing"
    # Drives: plugged in (not mounted yet), mounted, not plugged in.
    (tmp / "stick" / "Novel").mkdir(parents=True)
    host = FakeHost(mount_dir=tmp / "stick")
    mgr.drives = Drives(runner=host.run, root=True)
    c.put("/api/projects/d1", json={"name": "Novel", "mountName": "Novel", "source": {
        "kind": "drive", "uuid": STICK, "label": "STICK", "fstype": "exfat", "subpath": "Novel"}})
    st = c.get("/api/projects/d1/status").json()
    assert st["available"] and not st["exists_on_disk"] and st["path"] is None
    host.mounted(STICK, str(tmp / "stick"))
    st = c.get("/api/projects/d1/status").json()
    assert st["available"] and st["exists_on_disk"] and st["path"] == str(tmp / "stick" / "Novel")
    c.put("/api/projects/d2", json={"name": "Gone", "mountName": "Gone", "source": {
        "kind": "drive", "uuid": "ffff-0000", "label": "Backup", "fstype": "ext4", "subpath": ""}})
    st = c.get("/api/projects/d2/status").json()
    assert not st["available"] and st["reason"] == "plug in the drive Backup"
    assert not any(call[0] == "systemd-mount" for call in host.calls)  # status never mounts
