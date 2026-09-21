"""Workspace orchestration: the one place the API, hotkeys and cloud relay call.

switch(id):
  ready + running  -> navigate the kiosk to the workspace stream
  otherwise        -> navigate to /starting/<id>, then bring it up:
                      pull image -> start -> wait for HTTP -> ready -> navigate
Workspaces stay running after you leave them; stop() is explicit.
"""
from __future__ import annotations

import asyncio
import logging
import time
from urllib.parse import urlparse

from . import __version__
from .backends.base import Backend
from .config import (Config, ConfigError, WorkspaceSpec, config_to_dict, parse_config,
                     save_config, workspace_to_dict)
from .kiosk import Kiosk, KioskUnavailable
from .readiness import http_ok, wait_http_ok
from .state import (BUSY, ERROR, IDLE, PULLING, READY, STARTING, STOPPING, WAITING,
                    EventBus, WorkspaceState)

log = logging.getLogger(__name__)
RUNNING = "running"


class WorkspaceManager:
    def __init__(self, cfg: Config, backend: Backend, kiosk: Kiosk, bus: EventBus | None = None,
                 ready_poll_s: float = 1.0) -> None:
        self.cfg = cfg
        self.backend = backend
        self.kiosk = kiosk
        self.bus = bus or EventBus()
        self.ready_poll_s = ready_poll_s
        self.states: dict[str, WorkspaceState] = {ws.id: WorkspaceState() for ws in cfg.workspaces}
        self.locks: dict[str, asyncio.Lock] = {ws.id: asyncio.Lock() for ws in cfg.workspaces}
        self.tasks: dict[str, asyncio.Task] = {}
        self.pending_switch: str | None = None
        self.view = "launcher"
        self.backend_ok = False
        self.enrolled = False
        self.hotkey_devices: list[str] = []

    # ------------------------------------------------------------- helpers
    @property
    def launcher_url(self) -> str:
        return f"{self.cfg.daemon.base_url}/"

    def _ws(self, ws_id: str) -> WorkspaceSpec:
        ws = self.cfg.workspace(ws_id)
        if not ws.enabled:
            raise KeyError(ws_id)
        return ws

    def _set(self, ws_id: str, **changes) -> None:
        st = self.states[ws_id]
        if "phase" in changes and changes["phase"] != st.phase:
            st.since = time.time()
            if changes["phase"] != ERROR:
                st.error = None
            if changes["phase"] not in BUSY:
                st.progress = None
                st.message = None
        for k, v in changes.items():
            setattr(st, k, v)
        self.publish()

    def publish(self) -> None:
        self.bus.publish({"type": "state", "data": self.snapshot()})

    def workspace_dict(self, ws: WorkspaceSpec) -> dict:
        return {
            "id": ws.id,
            "name": ws.name,
            "port": ws.port,
            "url": ws.url,
            "hotkey": ws.hotkey,
            "icon": f"/api/icons/{ws.id}" if ws.icon else None,
            "enabled": ws.enabled,
            "image": ws.image,
            "state": self.states[ws.id].to_dict(),
        }

    def snapshot(self) -> dict:
        return {
            "machine": self.cfg.machine_name,
            "version": __version__,
            "view": self.view,
            "kiosk_connected": bool(getattr(self.kiosk, "connected", False)),
            "backend": self.backend.name,
            "backend_connected": self.backend_ok,
            "enrolled": self.enrolled,
            "cloud_enabled": self.cfg.cloud is not None,
            "hotkey_devices": len(self.hotkey_devices),
            "wadcreator_url": self.cfg.launcher.wadcreator_url,
            "workspaces": [self.workspace_dict(ws) for ws in self.cfg.enabled_workspaces],
        }

    async def _navigate(self, url: str, view: str) -> bool:
        self.view = view
        try:
            await self.kiosk.navigate(url)
            return True
        except KioskUnavailable as e:
            log.warning("kiosk navigation failed: %s", e)
            return False
        finally:
            self.publish()

    # ------------------------------------------------------------ commands
    async def switch(self, ws_id: str) -> None:
        ws = self._ws(ws_id)
        st = self.states[ws.id]
        if st.phase == READY and st.container == RUNNING:
            self.pending_switch = None
            await self._navigate(ws.url, f"workspace:{ws.id}")
            return
        self.pending_switch = ws.id
        await self._navigate(f"{self.cfg.daemon.base_url}/starting/{ws.id}", f"starting:{ws.id}")
        await self.start(ws.id)

    async def start(self, ws_id: str) -> None:
        ws = self._ws(ws_id)
        task = self.tasks.get(ws.id)
        if task and not task.done():
            return  # already coming up
        self.tasks[ws.id] = asyncio.create_task(self._bring_up(ws))

    async def _bring_up(self, ws: WorkspaceSpec) -> None:
        async with self.locks[ws.id]:
            try:
                self._set(ws.id, phase=PULLING, message="checking image")
                await self.backend.ensure_image(
                    ws, lambda pct, msg: self._set(ws.id, progress=pct, message=msg))
                if await self.backend.state(ws) != RUNNING:
                    self._set(ws.id, phase=STARTING, message="starting container")
                    await self.backend.start(ws)
                self._set(ws.id, phase=WAITING, container=RUNNING, message="waiting for the desktop")
                await wait_http_ok(ws.url, self.cfg.daemon.ready_timeout_s, self.ready_poll_s)
                self._set(ws.id, phase=READY)
                log.info("%s ready at %s", ws.id, ws.url)
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001 - surfaced to the user
                log.exception("bringing up %s failed", ws.id)
                self._set(ws.id, phase=ERROR, error=str(e))
                return
        if self.pending_switch == ws.id:
            self.pending_switch = None
            await self._navigate(ws.url, f"workspace:{ws.id}")

    async def stop(self, ws_id: str) -> None:
        ws = self._ws(ws_id)
        task = self.tasks.pop(ws.id, None)
        if task and not task.done():
            task.cancel()
        if self.pending_switch == ws.id:
            self.pending_switch = None
        async with self.locks[ws.id]:
            self._set(ws.id, phase=STOPPING, message="stopping")
            try:
                await self.backend.stop(ws)
                self._set(ws.id, phase=IDLE, container=await self.backend.state(ws))
            except Exception as e:  # noqa: BLE001
                log.exception("stopping %s failed", ws.id)
                self._set(ws.id, phase=ERROR, error=str(e))
        if self.view == f"workspace:{ws.id}":
            await self.show_launcher()

    async def restart(self, ws_id: str) -> None:
        ws = self._ws(ws_id)
        async with self.locks[ws.id]:
            self._set(ws.id, phase=STARTING, message="restarting")
            try:
                await self.backend.restart(ws)
            except Exception as e:  # noqa: BLE001
                self._set(ws.id, phase=ERROR, error=str(e))
                return
        if self.view == f"workspace:{ws.id}":
            self.pending_switch = ws.id
            await self._navigate(f"{self.cfg.daemon.base_url}/starting/{ws.id}", f"starting:{ws.id}")
        self._set(ws.id, phase=IDLE)
        await self.start(ws.id)

    async def show_launcher(self) -> None:
        self.pending_switch = None
        await self._navigate(self.launcher_url, "launcher")

    def navigate_allowed(self, url: str) -> bool:
        p = urlparse(url)
        if p.scheme == "http" and p.hostname in ("127.0.0.1", "localhost"):
            return True
        return any(url == a or url.startswith(a.rstrip("/") + "/")
                   for a in self.cfg.launcher.allow_navigate + [self.cfg.launcher.wadcreator_url] if a)

    async def navigate(self, url: str) -> None:
        if not self.navigate_allowed(url):
            raise PermissionError(f"navigation to {url} is not allowed")
        await self._navigate(url, self._view_for(url))

    async def on_hotkey(self, action: str) -> None:
        try:
            if action == "launcher":
                await self.show_launcher()
            elif action.startswith("switch:"):
                await self.switch(action.split(":", 1)[1])
        except KeyError:
            pass

    def hotkey_bindings(self) -> dict[int, str]:
        from .hotkeys import keycode
        b: dict[int, str] = {}
        for name in self.cfg.daemon.hotkeys.launcher:
            b[keycode(name)] = "launcher"
        for ws in self.cfg.enabled_workspaces:
            if ws.hotkey:
                b[keycode(f"KEY_{ws.hotkey}")] = f"switch:{ws.id}"
        return b

    # ---------------------------------------------------------------- CRUD
    # Wad Creator (served locally on :8081 for now) edits workspaces through
    # these. Changes are validated as a whole config, written back to
    # workspaces.yaml, and turned into quadlet units + daemon-reload.
    def spec_dict(self, ws_id: str) -> dict:
        return workspace_to_dict(self.cfg.workspace(ws_id))

    async def _apply(self, new_list: list[dict]) -> None:
        d = config_to_dict(self.cfg)
        d["workspaces"] = new_list
        new = parse_config(d, self.cfg.path)  # raises ConfigError
        if self.cfg.path:
            save_config(new, self.cfg.path)
        if self.backend.name == "systemd":
            from .quadlet import gen_quadlets
            gen_quadlets(new, self.cfg.daemon.quadlet_dir)
            await self.backend.daemon_reload()
        self.cfg.workspaces = new.workspaces
        for ws in new.workspaces:
            self.states.setdefault(ws.id, WorkspaceState())
            self.locks.setdefault(ws.id, asyncio.Lock())
        ids = {ws.id for ws in new.workspaces}
        for gone in [k for k in self.states if k not in ids]:
            self.states.pop(gone, None)
            self.locks.pop(gone, None)
            self.tasks.pop(gone, None)
        self.publish()

    async def create_workspace(self, spec: dict) -> dict:
        ws_id = spec.get("id")
        if any(w.id == ws_id for w in self.cfg.workspaces):
            raise ConfigError(f"workspace {ws_id!r} already exists")
        await self._apply([workspace_to_dict(w) for w in self.cfg.workspaces] + [spec])
        return self.spec_dict(ws_id)

    async def update_workspace(self, ws_id: str, spec: dict) -> dict:
        """Replace a workspace's spec. A running container keeps the old spec
        until restarted; the result says whether that is needed."""
        old = self.cfg.workspace(ws_id)
        spec = {**spec, "id": ws_id}
        await self._apply([spec if w.id == ws_id else workspace_to_dict(w) for w in self.cfg.workspaces])
        changed = workspace_to_dict(old) != self.spec_dict(ws_id)
        running = self.states[ws_id].container == RUNNING
        return {"workspace": self.spec_dict(ws_id), "restart_required": changed and running}

    async def delete_workspace(self, ws_id: str) -> None:
        ws = self.cfg.workspace(ws_id)
        if ws.enabled and self.states[ws_id].container == RUNNING:
            await self.stop(ws_id)
        await self._apply([workspace_to_dict(w) for w in self.cfg.workspaces if w.id != ws_id])

    # -------------------------------------------------------------- secrets
    @property
    def podman(self):
        return self.backend.api

    async def list_secrets(self) -> list[str]:
        return sorted((s.get("Spec") or {}).get("Name") or s.get("ID") for s in await self.podman.list_secrets())

    async def set_secret(self, name: str, value: str) -> None:
        await self.podman.create_secret(name, value.encode(), replace=True)

    async def delete_secret(self, name: str) -> bool:
        return await self.podman.delete_secret(name)

    # ------------------------------------------------------------- polling
    def _view_for(self, url: str | None) -> str:
        if not url:
            return self.view
        if url.startswith(self.cfg.daemon.base_url + "/starting/"):
            return "starting:" + url.rsplit("/", 1)[-1]
        if url.startswith(self.cfg.daemon.base_url):
            return "launcher"
        p = urlparse(url)
        if p.hostname in ("127.0.0.1", "localhost"):
            for ws in self.cfg.workspaces:
                if p.port == ws.port:
                    return f"workspace:{ws.id}"
        return "external"

    async def refresh(self) -> None:
        """Reconcile with podman and the kiosk (containers started elsewhere, crashes, ...)."""
        changed = False
        self.backend_ok = await self.backend.available()
        for ws in self.cfg.enabled_workspaces:
            st = self.states[ws.id]
            if self.locks[ws.id].locked():
                continue
            try:
                container = await self.backend.state(ws) if self.backend_ok else "unknown"
            except Exception as e:  # noqa: BLE001
                log.debug("state %s: %s", ws.id, e)
                container = "unknown"
            new = {}
            if container != st.container:
                new["container"] = container
            if container != RUNNING and st.phase == READY:
                new["phase"] = IDLE
            elif container == RUNNING and st.phase in (IDLE,) and await http_ok(ws.url):
                new["phase"] = READY
            if new:
                for k, v in new.items():
                    if k == "phase":
                        st.since = time.time()
                    setattr(st, k, v)
                changed = True
        try:
            view = self._view_for(await self.kiosk.current_url())
        except Exception:  # noqa: BLE001
            view = self.view
        if view != self.view:
            self.view = view
            changed = True
        if changed:
            self.publish()

    async def refresh_loop(self, interval: float = 5.0) -> None:
        while True:
            try:
                await self.refresh()
            except Exception:  # noqa: BLE001
                log.exception("refresh failed")
            await asyncio.sleep(interval)

    async def close(self) -> None:
        for t in self.tasks.values():
            t.cancel()
        await self.backend.close()
        await self.kiosk.close()
