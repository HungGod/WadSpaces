"""Relay between wadd and Wad Creator (Firebase), over plain HTTPS.

The host has no inbound port, so the daemon polls:
  enroll(code)  -> enrollMachine callable -> Firebase custom token -> ID token
  run()         -> heartbeat users/{uid}/machines/{mid} every 30 s
                -> poll .../commands where status == "pending" every 3 s,
                   execute via the WorkspaceManager, write status/result back
                -> sync users/{uid}/projects with the local project store
                   every PROJECTS_EVERY heartbeats, soon after a local change,
                   and on a `projects-sync` command
                -> write the owner's GitHub repos to users/{uid}/github/repos
                   (for the online app, which has no token) when they changed:
                   checked every REPOS_EVERY heartbeats, on `projects-sync`,
                   and after a repo is made here
  load_siblings() -> the owner's other machines (a launch reads them to
                   warn when a project is open on one of them)

Only httpx is used; no Firebase SDK on the host.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import socket
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

from . import __version__
from .config import CloudConfig
from .github import GitHubError
from .projects import OLD_FIELDS, now_ms
from .tailnet import TailnetError

log = logging.getLogger(__name__)
IDENTITY = "https://identitytoolkit.googleapis.com/v1"
SECURETOKEN = "https://securetoken.googleapis.com/v1"
# Projects sync every 4th heartbeat (2 min): each sync reads every project
# document, and Firestore bills per document read. A local change goes up on
# the next poll, and the online app can ask for one now (projects-sync).
PROJECTS_EVERY = 4
# What a machine writes to a project document. The old Syncthing fields
# (OLD_FIELDS) go in the update mask without a value, which removes them.
PROJECT_FIELDS = ("name", "mountName", "source", "setup", "deleted", "createdAt", "updatedAt")
# The repo list is checked every 20th heartbeat (10 min); it is only written
# when it changed.
REPOS_EVERY = 20
# A machine whose last heartbeat is older than this many heartbeats is offline.
OFFLINE_AFTER_BEATS = 3
# Joins the tailnet (tailscale up) rather than becoming a podman secret.
TAILSCALE_AUTHKEY = "tailscale_authkey"


class CloudError(RuntimeError):
    pass


# ---------------------------------------------------------- Firestore values
def to_value(v: Any) -> dict:
    if v is None:
        return {"nullValue": None}
    if isinstance(v, bool):
        return {"booleanValue": v}
    if isinstance(v, int):
        return {"integerValue": str(v)}
    if isinstance(v, float):
        return {"doubleValue": v}
    if isinstance(v, datetime):
        return {"timestampValue": v.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")}
    if isinstance(v, dict):
        return {"mapValue": {"fields": {k: to_value(x) for k, x in v.items()}}}
    if isinstance(v, (list, tuple)):
        return {"arrayValue": {"values": [to_value(x) for x in v]}}
    return {"stringValue": str(v)}


def from_value(v: dict) -> Any:
    (kind, x), = v.items()
    if kind == "nullValue":
        return None
    if kind == "integerValue":
        return int(x)
    if kind == "mapValue":
        return {k: from_value(y) for k, y in (x.get("fields") or {}).items()}
    if kind == "arrayValue":
        return [from_value(y) for y in (x.get("values") or [])]
    return x


def from_fields(fields: dict) -> dict:
    return {k: from_value(v) for k, v in (fields or {}).items()}


def now() -> datetime:
    return datetime.now(timezone.utc)


def to_ms(v: Any) -> int:
    """A project timestamp as epoch milliseconds, whether it came as a
    Firestore Timestamp (an RFC 3339 string here) or a number (Date.now())."""
    if isinstance(v, (int, float)):
        return int(v)
    if isinstance(v, str) and v:
        # Firestore gives up to nanoseconds; Python parses microseconds.
        v = re.sub(r"(\.\d{6})\d+", r"\1", v).replace("Z", "+00:00")
        try:
            return int(datetime.fromisoformat(v).timestamp() * 1000)
        except ValueError:
            pass
    return 0


def from_ms(ms: int) -> datetime:
    return datetime.fromtimestamp(ms / 1000, timezone.utc)


def project_from_doc(doc: dict) -> dict:
    """A users/{uid}/projects document (REST form) as a project-store document."""
    pid = doc["name"].rsplit("/", 1)[-1]
    data = from_fields(doc.get("fields"))
    return {**data, "id": pid, "createdAt": to_ms(data.get("createdAt")), "updatedAt": to_ms(data.get("updatedAt"))}


def machine_from_doc(doc: dict, now: int, online_ms: int) -> dict:
    """A users/{uid}/machines document (REST form) as a sibling:
    {id, name, online, ip, dnsName, stableId, mountedProjects}."""
    mid = doc["name"].rsplit("/", 1)[-1]
    data = from_fields(doc.get("fields"))
    tail = data.get("tailnet") if isinstance(data.get("tailnet"), dict) else {}
    seen = to_ms(data.get("lastSeen"))
    return {"id": mid, "name": data.get("name") or data.get("hostname") or mid,
            "online": bool(seen) and now - seen < online_ms,
            "ip": tail.get("ip"), "dnsName": tail.get("dnsName"), "stableId": tail.get("stableId"),
            "mountedProjects": list(data.get("mountedProjects") or [])}


def project_to_fields(doc: dict) -> dict:
    data = {k: doc.get(k) for k in PROJECT_FIELDS}
    data["createdAt"] = from_ms(int(doc.get("createdAt") or 0))
    data["updatedAt"] = from_ms(int(doc.get("updatedAt") or 0))
    return data


class CloudRelay:
    def __init__(self, cfg: CloudConfig, manager=None, machine_name: str = "wadspaces") -> None:
        self.cfg = cfg
        self.manager = manager
        self.machine_name = machine_name
        self.http = httpx.AsyncClient(timeout=20.0)
        self.state_path = Path(cfg.state_file)
        self.state: dict = {}
        self.id_token: str | None = None
        self.id_token_exp = 0.0
        self.beats = 0
        self.projects_seen = -1  # store.changes at the last sync; -1: never synced
        self.repos_written: dict | None = None  # {login, repos} as last written
        self.repos_due = False  # write the repo list on the next poll (a repo was made)
        self.siblings: list[dict] = []  # the owner's other machines (machine_from_doc)
        self.load()
        if manager is not None:
            manager.cloud = self

    # ------------------------------------------------------------ persistence
    def load(self) -> None:
        try:
            self.state = json.loads(self.state_path.read_text())
        except (OSError, ValueError):
            self.state = {}

    def save(self) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.state_path.with_suffix(".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(self.state, f, indent=2)
        tmp.replace(self.state_path)

    @property
    def enrolled(self) -> bool:
        return bool(self.state.get("refresh_token") and self.state.get("machine_id"))

    @property
    def machine_id(self) -> str | None:
        return self.state.get("machine_id")

    @property
    def api_key(self) -> str:
        return self.state.get("api_key") or self.cfg.api_key

    # ------------------------------------------------------------------ auth
    async def enroll(self, code: str) -> dict:
        r = await self.http.post(f"{self.cfg.functions_url}/enrollMachine",
                                 json={"data": {"code": code, "hostname": socket.gethostname(),
                                                "machineName": self.machine_name,
                                                "daemonVersion": __version__}})
        body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
        if r.status_code != 200 or "result" not in body:
            msg = (body.get("error") or {}).get("message") or r.text[:200]
            raise CloudError(f"enrollment failed: {msg}")
        res = body["result"]
        api_key = res.get("apiKey") or self.cfg.api_key
        tok = await self._post_identity("accounts:signInWithCustomToken", api_key,
                                        {"token": res["customToken"], "returnSecureToken": True})
        previous = self.state.get("owner_uid")
        if previous and previous != res["ownerUid"]:
            await self._forget_owner(previous)
        self.state = {
            "machine_id": res["machineId"],
            "owner_uid": res["ownerUid"],
            "project_id": res.get("projectId") or self.cfg.project_id,
            "api_key": api_key,
            "refresh_token": tok["refreshToken"],
            "enrolled_at": now().isoformat(),
        }
        self.id_token = tok["idToken"]
        self.id_token_exp = time.time() + int(tok.get("expiresIn", 3600))
        self.save()
        if self.manager:
            self.manager.enrolled = True
            self.manager.publish()
        log.info("enrolled as machine %s", res["machineId"])
        return {"machineId": res["machineId"]}

    async def _forget_owner(self, uid: str) -> None:
        """Linked to someone else now: the last owner's projects and GitHub
        token mustn't become theirs. The project documents move aside (the
        relay would push them up to the new account); the clones stay on disk,
        unused, under their old ids."""
        if self.manager is None:
            return
        root = self.manager.projects.root
        if root.is_dir() and any(root.iterdir()):
            aside = root.with_name(f"projects.{uid}.{int(time.time())}")
            root.rename(aside)
            self.projects_seen = -1
            log.info("linked to a new owner: %s's projects moved to %s", uid, aside)
        try:
            if await self.manager.delete_secret("github_token"):
                log.info("linked to a new owner: removed %s's github_token", uid)
        except Exception as e:  # noqa: BLE001 - linking still goes ahead
            log.warning("couldn't remove the last owner's github_token: %s", e)

    async def _post_identity(self, path: str, api_key: str, payload: dict) -> dict:
        r = await self.http.post(f"{IDENTITY}/{path}", params={"key": api_key}, json=payload)
        if r.status_code != 200:
            raise CloudError(f"{path}: {r.text[:200]}")
        return r.json()

    async def token(self) -> str:
        if self.id_token and time.time() < self.id_token_exp - 300:
            return self.id_token
        if not self.enrolled:
            raise CloudError("not enrolled")
        r = await self.http.post(f"{SECURETOKEN}/token", params={"key": self.api_key},
                                 data={"grant_type": "refresh_token",
                                       "refresh_token": self.state["refresh_token"]})
        if r.status_code != 200:
            raise CloudError(f"token refresh failed: {r.text[:200]}")
        body = r.json()
        self.id_token = body["id_token"]
        self.id_token_exp = time.time() + int(body.get("expires_in", 3600))
        if body.get("refresh_token") and body["refresh_token"] != self.state["refresh_token"]:
            self.state["refresh_token"] = body["refresh_token"]
            self.save()
        return self.id_token

    # ------------------------------------------------------------- firestore
    @property
    def machine_doc(self) -> str:
        return f"users/{self.state['owner_uid']}/machines/{self.state['machine_id']}"

    async def _fs(self, method: str, path: str, **kw) -> httpx.Response:
        """path is under documents/; ":runQuery" alone queries the root collections."""
        headers = {"Authorization": f"Bearer {await self.token()}"}
        url = f"{self.cfg.firestore_url}{path}" if path.startswith(":") else f"{self.cfg.firestore_url}/{path}"
        r = await self.http.request(method, url, headers=headers, **kw)
        if r.status_code >= 400:
            raise CloudError(f"firestore {method} {path}: {r.status_code} {r.text[:200]}")
        return r

    async def list_docs(self, path: str, page_size: int = 300) -> list[dict]:
        """Every document of a collection (REST form), page by page."""
        docs, page = [], None
        while True:
            params = {"pageSize": page_size, **({"pageToken": page} if page else {})}
            body = (await self._fs("GET", path, params=params)).json()
            docs += body.get("documents", [])
            page = body.get("nextPageToken")
            if not page:
                return docs

    async def patch(self, path: str, data: dict, remove: tuple[str, ...] = ()) -> None:
        """Set these fields (and remove the `remove` ones), leaving the rest."""
        params = [("updateMask.fieldPaths", k) for k in (*data, *remove)]
        await self._fs("PATCH", path, params=params,
                       json={"fields": {k: to_value(v) for k, v in data.items()}})

    async def heartbeat(self) -> None:
        m = self.manager
        snap = m.snapshot() if m else {}
        data = {
            "lastSeen": now(),
            "hostname": socket.gethostname(),
            "daemonVersion": __version__,
            "view": snap.get("view"),
            "workspaces": [
                {"id": w["id"], "name": w["name"], "port": w["port"], "hotkey": w["hotkey"],
                 "container": w["state"]["container"], "phase": w["state"]["phase"],
                 "error": w["state"]["error"]}
                for w in snap.get("workspaces", [])
            ],
        }
        if m is not None:
            data["mountedProjects"] = m.mounted_projects()
            watch = getattr(m, "tailnet", None)
            if watch is not None and watch.status.get("installed"):
                t = watch.status
                data["tailnet"] = {"online": bool(t.get("online")), "ip": t.get("ip"),
                                   "dnsName": t.get("dnsName"), "stableId": t.get("stableId")}
            data["streams"] = watch.streams() if watch is not None else []
        await self.patch(self.machine_doc, data)

    async def pending_commands(self) -> list[tuple[str, dict]]:
        q = {"structuredQuery": {
            "from": [{"collectionId": "commands"}],
            "where": {"fieldFilter": {"field": {"fieldPath": "status"}, "op": "EQUAL",
                                      "value": {"stringValue": "pending"}}},
            "limit": 10,
        }}
        r = await self._fs("POST", f"{self.machine_doc}:runQuery", json=q)
        out = []
        for row in r.json():
            doc = row.get("document")
            if doc:
                name = doc["name"].split("/documents/", 1)[1]
                out.append((name, from_fields(doc.get("fields"))))
        out.sort(key=lambda x: str(x[1].get("createdAt", "")))
        return out

    async def execute(self, cmd: dict) -> dict:
        m = self.manager
        kind = cmd.get("type")
        ws_id = cmd.get("wsId")
        if kind in ("switch", "start", "stop", "restart"):
            if not ws_id:
                raise CloudError(f"{kind} needs wsId")
            await getattr(m, kind)(ws_id)
        elif kind == "launcher":
            await m.show_launcher()
        elif kind == "navigate":
            await m.navigate(cmd.get("url") or "")
        elif kind == "refresh":
            await m.refresh()
        elif kind == "sync-secrets":
            return await self.sync_secrets()
        elif kind == "projects-sync":
            out = await self.sync_projects()
            try:
                out["repos"] = await self.sync_repos(fresh=True)
            except (GitHubError, CloudError, httpx.HTTPError) as e:
                log.warning("GitHub repo list: %s", e)
                out["repos"] = {"error": str(e)}
            return out
        else:
            raise CloudError(f"unknown command type {kind!r}")
        return {"ok": True}

    async def sync_secrets(self) -> dict:
        """Copy the owner's secrets from Wad Creator into podman's secret
        store. tailscale_authkey is not a container's: with it, a machine not
        yet on the tailnet joins it."""
        from .backends.podman import PodmanApi
        docs = await self.list_docs(f"users/{self.state['owner_uid']}/secrets", page_size=100)
        api = PodmanApi(self.manager.cfg.daemon.podman_socket)
        names = []
        out: dict = {"ok": True}
        try:
            for d in docs:
                name = d["name"].rsplit("/", 1)[-1]
                value = from_fields(d.get("fields")).get("value") or ""
                if name == TAILSCALE_AUTHKEY:
                    out["tailnet"] = await self._join_tailnet(value)
                    continue
                await api.create_secret(name, value.encode(), replace=True)
                names.append(name)
        finally:
            await api.close()
        return {**out, "secrets": names}

    async def _join_tailnet(self, key: str) -> str:
        """joined | already | unavailable | error: <why>"""
        watch = getattr(self.manager, "tailnet", None)
        if watch is None or not key.strip():
            return "unavailable"
        status = await watch.client.status()
        if not status.get("installed"):
            return "unavailable"
        if status.get("loggedIn"):
            return "already"
        try:
            await watch.client.up_with_authkey(key)
        except TailnetError as e:
            log.warning("joining the tailnet with the auth key failed: %s", e)
            return f"error: {e}"
        watch.kick()
        log.info("joined the tailnet with the auth key from Wad Creator")
        return "joined"

    async def sync_projects(self) -> dict:
        """Two-way sync of the owner's projects: the newer updatedAt wins
        (ProjectStore.merge); what is newer here, or new, is written up.
        Machines never delete a project document: a deletion is a tombstone."""
        store = self.manager.projects
        store.claim_local(self.machine_id, self.machine_name)  # folder projects made before enrolling
        changes = store.changes
        base = f"users/{self.state['owner_uid']}/projects"
        remote = [project_from_doc(d) for d in await self.list_docs(base)]
        before = {d["id"]: d.get("updatedAt") for d in store.list(include_deleted=True)}
        push = store.merge(remote)
        sent = []
        for doc in push:
            try:
                await self.patch(f"{base}/{doc['id']}", project_to_fields(doc), remove=OLD_FIELDS)
            except CloudError as e:  # one refused (rules) shouldn't hold the rest up
                log.warning("project %s not sent: %s", doc["id"], e)
                continue
            sent.append(doc["id"])
        store.mark_synced(sent)
        self.projects_seen = changes
        pulled = [d["id"] for d in store.list(include_deleted=True) if before.get(d["id"]) != d.get("updatedAt")]
        if pulled:
            self.manager.publish_projects(pulled)
        return {"ok": True, "pulled": len(pulled), "pushed": len(sent)}

    # ----------------------------------------------------------------- GitHub
    async def sync_repos(self, fresh: bool = False) -> dict | None:
        """Write users/{uid}/github/repos = {login, repos, updatedAt} when the
        list differs from what was last written. None without a token (then
        there is nothing to say); else {written, count}."""
        gh = getattr(self.manager, "github", None)
        if gh is None:
            return None
        try:
            login, repos = await gh.repos(fresh=fresh)
        except GitHubError as e:
            if e.no_token:
                return None
            raise
        data = {"login": login, "repos": repos}
        if data == self.repos_written:
            return {"written": False, "count": len(repos)}
        await self.patch(f"users/{self.state['owner_uid']}/github/repos", {**data, "updatedAt": now()})
        self.repos_written = data
        return {"written": True, "count": len(repos)}

    async def maybe_sync_repos(self, beat: bool) -> None:
        """Every REPOS_EVERY heartbeats, or when asked (repos_due). Failures
        wait for the next turn."""
        due = self.repos_due or (beat and self.beats % REPOS_EVERY == 1)
        if not due:
            return
        self.repos_due = False
        try:
            await self.sync_repos()
        except (GitHubError, CloudError, httpx.HTTPError) as e:
            log.warning("GitHub repo list: %s", e)

    # -------------------------------------------------------------- machines
    async def load_siblings(self) -> list[dict]:
        """The owner's other machines (their machine documents)."""
        docs = await self.list_docs(f"users/{self.state['owner_uid']}/machines", page_size=100)
        t = now_ms()
        online_ms = OFFLINE_AFTER_BEATS * self.cfg.heartbeat_s * 1000
        self.siblings = [s for s in (machine_from_doc(d, t, online_ms) for d in docs)
                         if s["id"] != self.machine_id]
        return self.siblings

    def open_elsewhere(self, pid: str) -> list[str]:
        """Online sibling machines with this project mounted in a running
        workspace (as of the last load_siblings)."""
        return [s["name"] for s in self.siblings if s["online"] and pid in s["mountedProjects"]]

    async def maybe_sync_projects(self, beat: bool) -> None:
        """Every PROJECTS_EVERY heartbeats, or after a local change. A failure
        (e.g. rules that don't allow it yet) waits for the next turn without
        slowing the command polling down."""
        if self.manager is None or not hasattr(self.manager, "projects"):
            return
        due = (beat and self.beats % PROJECTS_EVERY == 1) or self.manager.projects.changes != self.projects_seen
        if not due:
            return
        try:
            await self.sync_projects()
        except (CloudError, httpx.HTTPError) as e:
            self.projects_seen = self.manager.projects.changes
            log.warning("projects sync: %s", e)

    async def poll_once(self) -> None:
        for path, cmd in await self.pending_commands():
            await self.patch(path, {"status": "running", "startedAt": now()})
            try:
                result = await self.execute(cmd)
                await self.patch(path, {"status": "done", "result": result, "finishedAt": now()})
            except Exception as e:  # noqa: BLE001 - reported back to Wad Creator
                log.warning("command %s failed: %s", path, e)
                await self.patch(path, {"status": "error", "result": {"error": str(e)},
                                        "finishedAt": now()})

    async def run(self) -> None:
        if self.manager:
            self.manager.enrolled = self.enrolled
        last_beat = 0.0
        backoff = self.cfg.poll_s
        while True:
            if not self.enrolled:
                await asyncio.sleep(5)
                continue
            try:
                beat = time.time() - last_beat >= self.cfg.heartbeat_s
                if beat:
                    await self.heartbeat()
                    last_beat = time.time()
                    self.beats += 1
                await self.maybe_sync_projects(beat)
                await self.maybe_sync_repos(beat)
                await self.poll_once()
                backoff = self.cfg.poll_s
            except (CloudError, httpx.HTTPError) as e:
                log.warning("cloud relay: %s", e)
                backoff = min(backoff * 2, 60)
            await asyncio.sleep(backoff)

    async def close(self) -> None:
        await self.http.aclose()
