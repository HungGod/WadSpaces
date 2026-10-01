"""GitHub, where projects live: a small REST client for api.github.com.

A project is a GitHub repo (projects.py). This lists the repos the owner can
use (what `gh repo list` shows, plus collaborations and organisations) and
creates new ones, with the podman `github_token` secret the workspaces push
with (gitimport.find_token):
  GET  /user        -> the login
  GET  /user/repos  -> every page of them, most recently pushed first;
                       kept for CACHE_S, since the UI asks often
  POST /user/repos  -> a new repo, private unless asked, with a first commit
                       so it can be cloned straight away
Wad Creator gets the list from /api/github/repos offline, and from
users/{uid}/github/repos in Firestore (which cloud.py writes) online.
"""
from __future__ import annotations

import hashlib
import logging
import time
from typing import Awaitable, Callable

import httpx

log = logging.getLogger(__name__)

API = "https://api.github.com"
CACHE_S = 60.0
REPOS_QUERY = {"per_page": 100, "sort": "pushed", "affiliation": "owner,collaborator,organization_member"}
NO_TOKEN = "no GitHub token on this machine (the github_token secret)"
REFUSED = "the GitHub token was refused"


class GitHubError(RuntimeError):
    """status: GitHub's HTTP status (0: no answer, or no token)."""

    def __init__(self, message: str, status: int = 0, no_token: bool = False) -> None:
        super().__init__(message)
        self.status = status
        self.no_token = no_token


def repo_shape(r: dict) -> dict:
    """A GitHub repo as Wad Creator sees it (and users/{uid}/github/repos holds)."""
    return {"fullName": r.get("full_name") or "", "name": r.get("name") or "",
            "private": bool(r.get("private")), "url": r.get("clone_url") or "",
            "defaultBranch": r.get("default_branch") or "", "pushedAt": r.get("pushed_at"),
            "description": r.get("description") or ""}


def _message(r: httpx.Response) -> str:
    """What GitHub said went wrong: the field errors when there are any
    ("name already exists on this account"), else its message."""
    try:
        body = r.json()
    except ValueError:
        return r.text[:200] or f"HTTP {r.status_code}"
    errors = [e.get("message") or f"{e.get('field')} {e.get('code')}"
              for e in (body.get("errors") or []) if isinstance(e, dict)]
    return "; ".join(errors) or body.get("message") or f"HTTP {r.status_code}"


class GitHub:
    def __init__(self, token: Callable[[], Awaitable[str | None]],
                 transport: httpx.AsyncBaseTransport | None = None) -> None:
        """token(): the current token, or None (looked up on every call, so a
        secret set in the Manager counts straight away)."""
        self._token = token
        self._transport = transport
        self._client: httpx.AsyncClient | None = None
        # (sha256 of the token, monotonic time, login, repos)
        self._cache: tuple[str, float, str, list[dict]] | None = None

    def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(base_url=API, transport=self._transport, timeout=20.0)
        return self._client

    async def token(self) -> str:
        tok = await self._token()
        if not tok:
            raise GitHubError(NO_TOKEN, no_token=True)
        return tok

    async def _request(self, method: str, url: str, tok: str, **kw) -> httpx.Response:
        headers = {"Authorization": f"Bearer {tok}", "Accept": "application/vnd.github+json",
                   "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "wadd"}
        try:
            r = await self._http().request(method, url, headers=headers, **kw)
        except httpx.HTTPError as e:
            raise GitHubError(f"GitHub didn't answer: {e}") from e
        if r.status_code == 401:
            raise GitHubError(REFUSED, 401)
        if r.status_code == 422:  # e.g. a repo by that name already exists
            raise GitHubError(_message(r), 422)
        if r.status_code >= 400:
            raise GitHubError(f"GitHub {r.status_code}: {_message(r)}", r.status_code)
        return r

    async def whoami(self) -> dict:
        tok = await self.token()
        cached = self._cached(tok)
        if cached is not None:
            return {"login": cached[0]}
        r = await self._request("GET", "/user", tok)
        return {"login": r.json().get("login")}

    async def list_repos(self, fresh: bool = False) -> list[dict]:
        return (await self.repos(fresh))[1]

    async def repos(self, fresh: bool = False) -> tuple[str, list[dict]]:
        """(login, repos): every page, cached for CACHE_S unless fresh."""
        tok = await self.token()
        cached = None if fresh else self._cached(tok)
        if cached is not None:
            return cached
        login = (await self._request("GET", "/user", tok)).json().get("login") or ""
        out: list[dict] = []
        url: str | None = "/user/repos"
        params: dict | None = REPOS_QUERY
        while url:
            r = await self._request("GET", url, tok, params=params)
            out += [repo_shape(x) for x in r.json() if isinstance(x, dict)]
            url = r.links.get("next", {}).get("url")
            params = None  # the next link carries them
        self._cache = (_key(tok), time.monotonic(), login, out)
        return login, out

    def _cached(self, tok: str) -> tuple[str, list[dict]] | None:
        c = self._cache
        if c is None or c[0] != _key(tok) or time.monotonic() - c[1] > CACHE_S:
            return None
        return c[2], c[3]

    def invalidate(self) -> None:
        self._cache = None

    async def create_repo(self, name: str, private: bool = True, description: str = "") -> dict:
        tok = await self.token()
        r = await self._request("POST", "/user/repos", tok, json={
            "name": name, "private": private, "description": description, "auto_init": True})
        self.invalidate()
        repo = repo_shape(r.json())
        log.info("created GitHub repo %s", repo["fullName"])
        return repo

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None


def _key(tok: str) -> str:
    return hashlib.sha256(tok.encode()).hexdigest()
