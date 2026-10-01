"""GitHub: the client (wadd/github.py) and /api/github, against a fake api.github.com."""
import asyncio
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from wadd import github as github_mod
from wadd.api import create_app
from wadd.config import parse_config
from wadd.github import NO_TOKEN, REFUSED, GitHub, GitHubError
from wadd.kiosk import NullKiosk
from wadd.manager import WorkspaceManager
from test_manager import FakeBackend

TOKEN = "ghp_" + "G" * 36


def repo(name: str, owner: str = "octo", private: bool = True) -> dict:
    """A repo as GitHub's REST API gives it (with some of the many other fields)."""
    return {"id": hash(name) & 0xFFFF, "name": name, "full_name": f"{owner}/{name}", "private": private,
            "clone_url": f"https://github.com/{owner}/{name}.git", "ssh_url": f"git@github.com:{owner}/{name}.git",
            "default_branch": "main", "pushed_at": "2026-09-30T12:00:00Z", "description": None,
            "owner": {"login": owner}}


class FakeGitHubApi:
    """GET /user, GET /user/repos in pages of `page` (Link: rel="next"), POST /user/repos."""

    def __init__(self, repos: list[dict], page: int = 2):
        self.repos = repos
        self.page = page
        self.requests: list[httpx.Request] = []
        self.status: int | None = None  # answer everything with this instead

    def handler(self, req: httpx.Request) -> httpx.Response:
        self.requests.append(req)
        assert req.headers["authorization"] == f"Bearer {TOKEN}"
        assert req.headers["accept"] == "application/vnd.github+json"
        assert req.headers["x-github-api-version"] == "2022-11-28" and req.headers["user-agent"] == "wadd"
        if self.status:
            return httpx.Response(self.status, json={"message": "Bad credentials"})
        if req.url.path == "/user":
            return httpx.Response(200, json={"login": "octo", "id": 1})
        if req.url.path == "/user/repos" and req.method == "GET":
            q = req.url.params
            assert q["per_page"] == "100" and q["sort"] == "pushed"
            assert q["affiliation"] == "owner,collaborator,organization_member"
            n = int(q.get("page", "1"))
            chunk = self.repos[(n - 1) * self.page:n * self.page]
            headers = {}
            if n * self.page < len(self.repos):
                nxt = req.url.copy_set_param("page", str(n + 1))
                headers["link"] = f'<{nxt}>; rel="next", <{nxt}>; rel="last"'
            return httpx.Response(200, json=chunk, headers=headers)
        if req.url.path == "/user/repos" and req.method == "POST":
            body = json.loads(req.content)
            if any(r["name"] == body["name"] for r in self.repos):
                return httpx.Response(422, json={"message": "Repository creation failed.", "errors": [
                    {"resource": "Repository", "code": "custom", "field": "name",
                     "message": "name already exists on this account"}]})
            made = {**repo(body["name"], private=body["private"]), "description": body["description"] or None,
                    "auto_init": body["auto_init"]}
            self.repos.insert(0, made)
            return httpx.Response(201, json=made)
        return httpx.Response(404, json={"message": "Not Found"})


def client(api: FakeGitHubApi, token: str | None = TOKEN) -> GitHub:
    async def tok():
        return token
    return GitHub(tok, transport=httpx.MockTransport(api.handler))


def test_whoami_and_every_page_of_repos():
    api = FakeGitHubApi([repo(f"r{i}") for i in range(5)])
    gh = client(api)

    async def go():
        assert await gh.whoami() == {"login": "octo"}
        return await gh.list_repos()
    repos = asyncio.run(go())
    assert [r["name"] for r in repos] == ["r0", "r1", "r2", "r3", "r4"]  # 3 pages
    assert repos[0] == {"fullName": "octo/r0", "name": "r0", "private": True,
                        "url": "https://github.com/octo/r0.git", "defaultBranch": "main",
                        "pushedAt": "2026-09-30T12:00:00Z", "description": ""}
    assert [r.url.params.get("page") for r in api.requests if r.url.path == "/user/repos"] == [None, "2", "3"]


def test_the_list_is_cached_until_it_expires_or_a_repo_is_made(monkeypatch):
    api = FakeGitHubApi([repo("a")])
    gh = client(api)
    clock = [1000.0]
    monkeypatch.setattr(github_mod.time, "monotonic", lambda: clock[0])

    async def go():
        await gh.list_repos()
        n = len(api.requests)
        assert (await gh.repos()) == ("octo", await gh.list_repos())
        assert await gh.whoami() == {"login": "octo"}  # from the cache as well
        assert len(api.requests) == n
        clock[0] += github_mod.CACHE_S + 1
        await gh.list_repos()
        assert len(api.requests) == 2 * n
        await gh.list_repos(fresh=True)
        assert len(api.requests) == 3 * n
        made = await gh.create_repo("b")
        assert [r["name"] for r in await gh.list_repos()] == ["b", "a"]  # asked again after the create
        return made
    made = asyncio.run(go())
    assert made["fullName"] == "octo/b" and made["url"] == "https://github.com/octo/b.git" and made["private"]


def test_create_repo_is_private_and_initialised_by_default():
    api = FakeGitHubApi([])
    asyncio.run(client(api).create_repo("notes", description="my notes"))
    body = json.loads(api.requests[-1].content)
    assert body == {"name": "notes", "private": True, "description": "my notes", "auto_init": True}
    asyncio.run(client(api).create_repo("open", private=False))
    assert json.loads(api.requests[-1].content)["private"] is False


@pytest.mark.parametrize("setup, call, msg, status", [
    ({"token": None}, "whoami", NO_TOKEN, 0),
    ({"status": 401}, "whoami", REFUSED, 401),
    ({"status": 401}, "list_repos", REFUSED, 401),
    ({"status": 503}, "list_repos", "GitHub 503: Bad credentials", 503),
    ({}, "create_existing", "name already exists on this account", 422),
])
def test_errors(setup, call, msg, status):
    api = FakeGitHubApi([repo("taken")])
    api.status = setup.get("status")
    gh = client(api, setup.get("token", TOKEN))
    coro = gh.create_repo("taken") if call == "create_existing" else getattr(gh, call)()
    with pytest.raises(GitHubError) as e:
        asyncio.run(coro)
    assert str(e.value) == msg and e.value.status == status
    assert e.value.no_token == (setup.get("token", TOKEN) is None)


def test_github_unreachable():
    def down(req):
        raise httpx.ConnectError("no route to host")
    gh = GitHub(lambda: asyncio.sleep(0, TOKEN), transport=httpx.MockTransport(down))
    with pytest.raises(GitHubError, match="GitHub didn't answer"):
        asyncio.run(gh.whoami())


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
    fake = FakeGitHubApi([repo("notes"), repo("web", owner="org", private=False)])
    token = {"value": TOKEN}

    async def tok():
        return token["value"]
    mgr.github = GitHub(tok, transport=httpx.MockTransport(fake.handler))
    return TestClient(create_app(mgr)), mgr, fake, token, events


def test_api_github(api):
    c, mgr, fake, token, _ = api
    assert c.get("/api/github").json() == {"token": True, "login": "octo"}
    fake.status = 401
    assert c.get("/api/github").json() == {"token": True, "login": None, "error": REFUSED}
    token["value"] = None
    assert c.get("/api/github").json() == {"token": False, "login": None}


def test_api_github_repos(api):
    c, mgr, fake, token, _ = api
    body = c.get("/api/github/repos").json()
    assert body["login"] == "octo" and [r["fullName"] for r in body["repos"]] == ["octo/notes", "org/web"]
    assert body["repos"][1]["private"] is False
    mgr.github.invalidate()
    fake.status = 401
    r = c.get("/api/github/repos")
    assert r.status_code == 502 and r.json()["detail"] == REFUSED
    token["value"] = None
    r = c.get("/api/github/repos")
    assert r.status_code == 409 and r.json()["detail"] == NO_TOKEN


def test_api_create_repo_makes_the_project(api):
    c, mgr, fake, token, events = api

    class Cloud:
        repos_due = False
    mgr.cloud = Cloud()
    r = c.post("/api/github/repos", json={"name": "My Notes", "setup": "make"})
    assert r.status_code == 422 and "letters, digits" in r.json()["detail"]
    r = c.post("/api/github/repos", json={"name": "new-notes", "setup": "make", "description": "d"})
    assert r.status_code == 201, r.text
    doc = r.json()
    assert doc["name"] == "new-notes" and doc["mountName"] == "new-notes" and doc["setup"] == "make"
    assert doc["source"] == {"kind": "git", "url": "https://github.com/octo/new-notes.git"}
    assert mgr.projects.get(doc["id"]) == doc and "legacy" not in doc
    assert events[-1] == {"type": "projects", "data": {"ids": [doc["id"]]}}
    assert mgr.cloud.repos_due  # the online app's list gets it soon
    made = json.loads(fake.requests[-1].content)
    assert made == {"name": "new-notes", "private": True, "description": "d", "auto_init": True}
    # An explicit folder name, and a public repo.
    doc2 = c.post("/api/github/repos", json={"name": "site", "private": False, "mountName": "Site"}).json()
    assert doc2["mountName"] == "Site" and json.loads(fake.requests[-1].content)["private"] is False
    # Refused before GitHub is asked: the folder name is taken, or bad.
    n = len(fake.requests)
    r = c.post("/api/github/repos", json={"name": "other", "mountName": "Site"})
    assert r.status_code == 409 and "Site" in r.json()["detail"]
    assert c.post("/api/github/repos", json={"name": "other", "mountName": "a/b"}).status_code == 422
    assert len(fake.requests) == n
    # GitHub refuses: its message.
    r = c.post("/api/github/repos", json={"name": "notes"})
    assert r.status_code == 422 and r.json()["detail"] == "name already exists on this account"
    token["value"] = None
    assert c.post("/api/github/repos", json={"name": "x"}).status_code == 409
    r = c.post("/api/github/repos", json={"name": "y"}, headers={"Origin": "https://evil.example"})
    assert r.status_code == 403
    assert len(mgr.projects.list()) == 2
