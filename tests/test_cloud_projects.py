"""Projects sync through the cloud relay, against a fake Firestore REST API."""
import asyncio
import time
from datetime import datetime, timezone

import httpx
import pytest

from wadd.cloud import REPOS_EVERY, CloudRelay, from_fields, to_ms, to_value
from wadd.config import CloudConfig, parse_config
from wadd.github import NO_TOKEN, GitHubError
from wadd.kiosk import NullKiosk
from wadd.manager import WorkspaceManager
from test_manager import FakeBackend

ROOT = "projects/p/databases/(default)/documents"
REPO = {"fullName": "o/web", "name": "web", "private": True, "url": "https://github.com/o/web.git",
        "defaultBranch": "main", "pushedAt": "2026-10-01T00:00:00Z", "description": ""}


def gh(repo: str) -> dict:
    return {"kind": "git", "url": f"https://github.com/o/{repo}.git"}


class FakeGitHub:
    """What the relay asks of wadd.github.GitHub."""

    def __init__(self):
        self.login, self.list = "octo", [dict(REPO)]
        self.token = True
        self.calls = []

    async def repos(self, fresh=False):
        self.calls.append(fresh)
        if not self.token:
            raise GitHubError(NO_TOKEN, no_token=True)
        return self.login, [dict(r) for r in self.list]


class FakeFirestore:
    """Documents by path; list (one per page, to exercise paging), PATCH with
    an update mask, and runQuery for the pending commands."""

    def __init__(self):
        self.docs: dict[str, dict] = {}  # path -> fields (REST form)
        self.patches: list[tuple[str, list[str]]] = []
        self.deny_projects = False

    def handler(self, req: httpx.Request) -> httpx.Response:
        assert req.headers["authorization"] == "Bearer T"
        path = req.url.path.split(f"/{ROOT}/", 1)[1]
        if self.deny_projects and "/projects" in path:
            return httpx.Response(403, json={"error": {"message": "Missing or insufficient permissions."}})
        if req.method == "GET":
            prefix = path + "/"
            names = sorted(p for p in self.docs if p.startswith(prefix) and "/" not in p[len(prefix):])
            start = int(req.url.params.get("pageToken") or 0)
            body = {"documents": [{"name": f"{ROOT}/{n}", "fields": self.docs[n]} for n in names[start:start + 1]]}
            if start + 1 < len(names):
                body["nextPageToken"] = str(start + 1)
            return httpx.Response(200, json=body)
        if req.method == "PATCH":
            mask = req.url.params.get_list("updateMask.fieldPaths")
            self.patches.append((path, mask))
            fields = httpx.Response(200, content=req.content).json()["fields"]
            # A masked field without a value is removed, as Firestore does.
            doc = {k: v for k, v in self.docs.get(path, {}).items() if k not in mask}
            self.docs[path] = {**doc, **{k: fields[k] for k in mask if k in fields}}
            return httpx.Response(200, json={"name": f"{ROOT}/{path}", "fields": self.docs[path]})
        if req.method == "POST" and path.endswith(":runQuery"):
            base = path.removesuffix(":runQuery") + "/commands/"
            rows = [{"document": {"name": f"{ROOT}/{p}", "fields": f}} for p, f in self.docs.items()
                    if p.startswith(base) and from_fields(f).get("status") == "pending"]
            return httpx.Response(200, json=rows or [{"readTime": "2026-10-01T00:00:00Z"}])
        return httpx.Response(404)

    def put(self, path: str, data: dict) -> None:
        self.docs[path] = {k: to_value(v) for k, v in data.items()}

    def get(self, path: str) -> dict:
        return from_fields(self.docs[path])


@pytest.fixture
def relay(tmp_path):
    cfg = parse_config({"daemon": {"state_dir": str(tmp_path)},
                        "workspaces": [{"id": "a", "name": "A", "image": "i", "port": 3100}]})
    mgr = WorkspaceManager(cfg, FakeBackend(), NullKiosk())
    events = []
    mgr.bus.publish = events.append
    mgr.github = FakeGitHub()
    fs = FakeFirestore()
    r = CloudRelay(CloudConfig(project_id="p", firestore_base="http://fs", state_file=str(tmp_path / "enr.json")), mgr)
    r.state = {"owner_uid": "u1", "machine_id": "m1", "refresh_token": "x"}
    r.id_token, r.id_token_exp = "T", time.time() + 3600
    r.http = httpx.AsyncClient(transport=httpx.MockTransport(fs.handler))
    return r, mgr, fs, events


def ts(ms: int) -> datetime:
    return datetime.fromtimestamp(ms / 1000, timezone.utc)


def test_timestamps():
    assert to_ms("2026-10-01T00:00:00.123456789Z") == to_ms("2026-10-01T00:00:00.123Z") == 1790812800123
    assert to_ms(1790812800123) == 1790812800123 and to_ms(None) == 0 and to_ms("junk") == 0


def test_sync_pulls_newer_and_pushes_newer(relay):
    r, mgr, fs, events = relay
    store = mgr.projects
    here = store.put("here", {"name": "Made offline", "mountName": "Offline", "source": gh("here")})
    stale = store.put("stale", {"name": "Edited here", "mountName": "Stale", "source": gh("stale")})
    fs.put("users/u1/projects/stale", {"name": "Old online", "mountName": "Stale", "deleted": False,
                                       "source": gh("stale"), "updatedAt": ts(stale["updatedAt"] - 5000),
                                       "holders": {"m2": {"state": "idle", "bytes": 10}}, "ignore": ["x"],
                                       "folderId": "wad-stale"})
    fs.put("users/u1/projects/web", {"name": "Made online", "mountName": "Web", "setup": "npm ci",
                                     "source": {"kind": "git", "url": "https://github.com/o/web.git"},
                                     "ignore": ["node_modules"], "folderId": "wad-web", "holders": {},
                                     "deleted": False, "createdAt": ts(1000), "updatedAt": ts(2000)})
    fs.put("users/u1/projects/gone", {"name": "Deleted online", "mountName": "Gone", "deleted": True,
                                      "updatedAt": ts(3000)})
    result = asyncio.run(r.sync_projects())
    assert result == {"ok": True, "pulled": 2, "pushed": 2}
    web = store.get("web")
    assert web["setup"] == "npm ci" and web["updatedAt"] == 2000 and web["createdAt"] == 1000 and web["synced"]
    assert store.get("gone")["deleted"] and sorted(p["id"] for p in store.list()) == ["here", "stale", "web"]
    # Up went the offline project and the newer edit, never local keys; the
    # old Syncthing fields are removed from the cloud's copy.
    assert sorted(p for p, _ in fs.patches) == ["users/u1/projects/here", "users/u1/projects/stale"]
    for _, mask in fs.patches:
        assert "synced" not in mask and "id" not in mask and "legacy" not in mask
        assert {"holders", "ignore", "folderId"} <= set(mask)  # in the mask, not the body: removed
    up = fs.get("users/u1/projects/stale")
    assert up["name"] == "Edited here" and to_ms(up["updatedAt"]) == stale["updatedAt"]
    assert set(up) == {"name", "mountName", "source", "setup", "deleted", "createdAt", "updatedAt"}
    assert to_ms(fs.get("users/u1/projects/here")["createdAt"]) == here["createdAt"]
    assert store.get("here")["synced"] and store.get("stale")["synced"]
    assert {"type": "projects", "data": {"ids": ["gone", "web"]}} in events
    # Nothing changed since: a second sync moves nothing.
    fs.patches.clear()
    assert asyncio.run(r.sync_projects()) == {"ok": True, "pulled": 0, "pushed": 0}
    assert fs.patches == []


def test_projects_sync_command(relay):
    r, mgr, fs, _ = relay
    mgr.projects.put("p1", {"name": "One", "mountName": "One", "source": gh("one")})
    fs.put("users/u1/machines/m1/commands/c1", {"type": "projects-sync", "status": "pending", "createdAt": ts(1)})
    asyncio.run(r.poll_once())
    cmd = fs.get("users/u1/machines/m1/commands/c1")
    assert cmd["status"] == "done"
    assert cmd["result"] == {"ok": True, "pulled": 0, "pushed": 1, "repos": {"written": True, "count": 1}}
    assert fs.get("users/u1/projects/p1")["name"] == "One"
    # The repo list went up too, straight from GitHub (not the cache).
    assert mgr.github.calls == [True]
    doc = fs.get("users/u1/github/repos")
    assert set(doc) == {"login", "repos", "updatedAt"}  # nothing else: the rules allow only these
    assert doc["login"] == "octo" and doc["repos"] == [REPO] and doc["updatedAt"].endswith("Z")


def test_legacy_projects_stay_here(relay):
    r, mgr, fs, _ = relay
    store = mgr.projects
    store.root.mkdir(parents=True, exist_ok=True)
    (store.root / "old.json").write_text(
        '{"id": "old", "name": "Old", "mountName": "Old", "source": {"kind": "empty"}, "updatedAt": 2}')
    assert asyncio.run(r.sync_projects())["pushed"] == 0
    assert fs.patches == [] and store.get("old")["legacy"]


def test_one_refused_project_does_not_hold_up_the_rest(relay):
    r, mgr, fs, _ = relay
    store = mgr.projects
    store.put("a", {"name": "A", "mountName": "A", "source": gh("a")})
    store.put("b", {"name": "B", "mountName": "B", "source": gh("b")})
    handler = fs.handler

    def refuse_a(req):
        if req.method == "PATCH" and req.url.path.endswith("/projects/a"):
            return httpx.Response(403, json={"error": {"message": "denied"}})
        return handler(req)
    r.http = httpx.AsyncClient(transport=httpx.MockTransport(refuse_a))
    assert asyncio.run(r.sync_projects())["pushed"] == 1
    assert not store.get("a")["synced"] and store.get("b")["synced"]


def test_the_repo_list_is_written_only_when_it_changes(relay):
    r, mgr, fs, _ = relay
    path = "users/u1/github/repos"

    async def go():
        assert await r.sync_repos() == {"written": True, "count": 1}
        assert await r.sync_repos() == {"written": False, "count": 1}
        mgr.github.list.append({**REPO, "fullName": "o/new", "name": "new"})
        assert await r.sync_repos() == {"written": True, "count": 2}
        mgr.github.login = "renamed"
        assert await r.sync_repos() == {"written": True, "count": 2}
        mgr.github.token = False  # no token: nothing to say, silently
        assert await r.sync_repos() is None
    asyncio.run(go())
    assert [p for p, _ in fs.patches] == [path] * 3
    assert fs.get(path)["login"] == "renamed" and len(fs.get(path)["repos"]) == 2


def test_the_repo_list_is_checked_every_ten_minutes_and_when_asked(relay):
    r, mgr, fs, _ = relay
    asked = []

    async def counting(fresh=False):
        asked.append(r.beats)
        return {"written": False, "count": 0}
    r.sync_repos = counting

    async def go():
        for beats in range(1, 2 * REPOS_EVERY + 2):
            r.beats = beats
            await r.maybe_sync_repos(beat=True)
        await r.maybe_sync_repos(beat=False)  # between beats: not due
        r.repos_due = True  # a repo was made here
        await r.maybe_sync_repos(beat=False)
        await r.maybe_sync_repos(beat=False)
    asyncio.run(go())
    assert asked == [1, REPOS_EVERY + 1, 2 * REPOS_EVERY + 1, 2 * REPOS_EVERY + 1]
    assert REPOS_EVERY * 30 == 600  # 30 s heartbeats: every ten minutes


def test_a_github_failure_does_not_stop_the_relay(relay):
    r, mgr, fs, _ = relay

    async def down(fresh=False):
        raise GitHubError("GitHub didn't answer: boom")
    mgr.github.repos = down
    r.repos_due = True
    asyncio.run(r.maybe_sync_repos(beat=False))  # logged, not raised
    assert not r.repos_due and fs.patches == []


def test_sync_runs_on_schedule_and_after_local_changes(relay):
    r, mgr, fs, _ = relay
    calls = []

    async def counting():
        calls.append(1)
        r.projects_seen = mgr.projects.changes
        return {"ok": True}
    r.sync_projects = counting

    async def go():
        await r.maybe_sync_projects(beat=False)  # never synced yet
        await r.maybe_sync_projects(beat=False)  # nothing new
        mgr.projects.put("p1", {"name": "One", "mountName": "One", "source": gh("one")})
        await r.maybe_sync_projects(beat=False)  # a local change
        for beats in (2, 3, 4, 5):
            r.beats = beats
            await r.maybe_sync_projects(beat=True)
    asyncio.run(go())
    assert len(calls) == 3  # first, after the change, on heartbeat 5 (every 4th)


def test_a_refused_sync_does_not_stop_the_relay(relay):
    r, mgr, fs, _ = relay
    fs.deny_projects = True
    mgr.projects.put("p1", {"name": "One", "mountName": "One", "source": gh("one")})
    asyncio.run(r.maybe_sync_projects(beat=True))  # logged, not raised
    assert r.projects_seen == mgr.projects.changes  # and not retried on every poll
    assert not mgr.projects.get("p1")["synced"]


def test_folder_projects_made_before_enrolling_go_up_as_this_machines(relay, tmp_path):
    r, mgr, fs, _ = relay
    (tmp_path / "home" / "Notes").mkdir(parents=True)
    mgr.projects.folder_roots = [str(tmp_path / "home")]
    r.machine_name = "Surface"
    enrolled, r.state = r.state, {}  # made before this machine was enrolled
    doc = mgr.projects.put("f1", {"name": "Notes", "mountName": "Notes",
                                  "source": {"kind": "folder", "path": str(tmp_path / "home" / "Notes")}})
    assert doc["source"]["machineId"] == "local"
    r.state = enrolled
    asyncio.run(r.sync_projects())
    up = fs.get("users/u1/projects/f1")["source"]
    assert up == {"kind": "folder", "machineId": "m1", "machineName": "Surface", "path": str(tmp_path / "home" / "Notes")}
    assert mgr.projects.get("f1")["source"]["machineId"] == "m1"


def test_projects_sync_reports_a_github_failure(relay):
    r, mgr, fs, _ = relay

    async def down(fresh=False):
        raise GitHubError("the GitHub token was refused", 401)
    mgr.github.repos = down
    out = asyncio.run(r.execute({"type": "projects-sync"}))
    assert out == {"ok": True, "pulled": 0, "pushed": 0, "repos": {"error": "the GitHub token was refused"}}
