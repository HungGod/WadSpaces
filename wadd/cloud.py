"""Relay between wadd and Wad Creator (Firebase), over plain HTTPS.

The host has no inbound port, so the daemon polls:
  enroll(code)  -> enrollMachine callable -> Firebase custom token -> ID token
  run()         -> heartbeat users/{uid}/machines/{mid} every 30 s
                -> poll .../commands where status == "pending" every 3 s,
                   execute via the WorkspaceManager, write status/result back

Only httpx is used; no Firebase SDK on the host.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import socket
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

from . import __version__
from .config import CloudConfig

log = logging.getLogger(__name__)
IDENTITY = "https://identitytoolkit.googleapis.com/v1"
SECURETOKEN = "https://securetoken.googleapis.com/v1"


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
        self.load()

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
        headers = {"Authorization": f"Bearer {await self.token()}"}
        r = await self.http.request(method, f"{self.cfg.firestore_url}/{path}", headers=headers, **kw)
        if r.status_code >= 400:
            raise CloudError(f"firestore {method} {path}: {r.status_code} {r.text[:200]}")
        return r

    async def patch(self, path: str, data: dict) -> None:
        params = [("updateMask.fieldPaths", k) for k in data]
        await self._fs("PATCH", path, params=params,
                       json={"fields": {k: to_value(v) for k, v in data.items()}})

    async def heartbeat(self) -> None:
        snap = self.manager.snapshot() if self.manager else {}
        await self.patch(self.machine_doc, {
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
        })

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
        else:
            raise CloudError(f"unknown command type {kind!r}")
        return {"ok": True}

    async def sync_secrets(self) -> dict:
        """Copy the owner's secrets from Wad Creator into podman's secret store."""
        from .backends.podman import PodmanApi
        r = await self._fs("GET", f"users/{self.state['owner_uid']}/secrets", params={"pageSize": 100})
        docs = r.json().get("documents", [])
        api = PodmanApi(self.manager.cfg.daemon.podman_socket)
        names = []
        try:
            for d in docs:
                name = d["name"].rsplit("/", 1)[-1]
                value = from_fields(d.get("fields")).get("value") or ""
                await api.create_secret(name, value.encode(), replace=True)
                names.append(name)
        finally:
            await api.close()
        return {"ok": True, "secrets": names}

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
                if time.time() - last_beat >= self.cfg.heartbeat_s:
                    await self.heartbeat()
                    last_beat = time.time()
                await self.poll_once()
                backoff = self.cfg.poll_s
            except (CloudError, httpx.HTTPError) as e:
                log.warning("cloud relay: %s", e)
                backoff = min(backoff * 2, 60)
            await asyncio.sleep(backoff)

    async def close(self) -> None:
        await self.http.aclose()
