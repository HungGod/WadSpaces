"""Workspace orchestration: the one place the API, hotkeys and cloud relay call.

The kiosk browser stays on the shell page (/) the whole time; that page keeps
each workspace in its own frame. wadd owns which view is on screen and tells
the shell over SSE, so a warm switch is instant and never reloads a stream.

switch(id):
  ready + running  -> show it now
  otherwise        -> stay where you are, bring it up in the background
                      (pull image -> start -> wait for HTTP -> ready), then show
Workspaces stay running after you leave them; stop() is explicit.

A native workspace (display: host) is not a frame but its own window on the
host compositor; `display` (display.py) puts it on screen, and it counts as
ready once its window appears rather than when a port answers.

A session (session_begin) is what Home's flow ends in: the picked workspaces
start, Home shows the landing page, and Super+Tab cycles only the picks. In
"focus" mode Home stays out of Super+Tab until the time is up; "free" mode
(focus skipped) has no timer and Home is always one Tab away. Before any
session, Super+Tab holds only Home.

After boot, prefetch_loop() waits for the network and brings up `autostart`
workspaces. With daemon.prefetch = "all" it also pulls every other image (while
the disk has room) so a first switch doesn't download; by default the rest are
pulled on first switch, which keeps small disks from filling up.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import shutil
import time
from pathlib import Path
from urllib.parse import urlparse

from . import __version__, gitimport, logbuffer, registry
from .backends.base import Backend
from .config import (Config, ConfigError, WorkspaceSpec, config_to_dict, parse_config,
                     save_config, workspace_to_dict)
from .builds import Builds
from .display import NullDisplay
from .drives import DriveError, Drives
from .github import GitHub
from .launches import Launches
from .library import Library
from .projects import LOCAL, ProjectConflict, ProjectStore, project_dir, purge_dir
from .runs import RunLog
from .kiosk import Kiosk, KioskUnavailable
from .readiness import http_ok, wait_http_ok
from .state import (BUSY, ERROR, IDLE, PULLING, READY, STARTING, STOPPING, WAITING,
                    EventBus, WorkspaceState)

log = logging.getLogger(__name__)
RUNNING = "running"
IMAGE_STORE = "/var/lib/containers/storage"  # rootful podman
PROGRESS_PUBLISH_S = 0.7  # how often pull progress reaches the launcher
SESSION_MAX_MIN = 12 * 60


class SessionLocked(PermissionError):
    """Home (and Wad Creator) are out of reach until the session's time is up."""

    def __init__(self) -> None:
        super().__init__("a focus session is in progress; Home comes back when the time is up")


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
        # most recently used views, newest first: the carousel's order
        self.mru: list[str] = []
        self.carousel: dict | None = None  # open Super+Tab switcher, if any
        self.key_router = None  # keyproxy.KeyRouter, when the keyboard proxy runs
        self.backend_ok = False
        self.enrolled = False
        self.hotkey_devices: list[str] = []
        self.network: dict = {}
        self.image_store = IMAGE_STORE
        # A few downloads at once (Home starts every pick together). Their
        # progress comes from one byte counter, split between them.
        self.pull_slots = asyncio.Semaphore(cfg.daemon.max_parallel_pulls)
        self._pulls: dict[str, registry.PullProgress] = {}
        self._rx_last = 0
        self._rx_task: asyncio.Task | None = None
        self.pull_sample_s = 1.0
        self._last_publish = 0.0
        self.display = NullDisplay()
        self.native_windows: dict[str, asyncio.Event] = {}
        self.session: dict | None = None
        self._session_task: asyncio.Task | None = None
        self._bg: set[asyncio.Task] = set()
        self._app_pending: str | None = None
        state_dir = Path(cfg.daemon.state_dir)
        self.builds = Builds(self)
        self.library = Library(state_dir / "library")
        self.runs = RunLog(state_dir / "runs.jsonl")
        self.projects = ProjectStore(state_dir / "projects", cfg.daemon.folder_roots, self.machine_ref)
        self.drives = Drives(cfg.daemon.projects_uid)
        self.launches = Launches(self)
        # Where projects live; its token is the github_token secret.
        self.github = GitHub(lambda: gitimport.find_token(getattr(self.backend, "api", None),
                                                           cfg.daemon.secrets_dir))
        # Set up by wadd serve when there is one: tailnet.TailnetWatch, and
        # cloud.CloudRelay (it sets itself).
        self.tailnet = None
        self.cloud = None

    # ------------------------------------------------------------- helpers
    @property
    def launcher_url(self) -> str:
        return f"{self.cfg.daemon.base_url}/"

    def _ws(self, ws_id: str) -> WorkspaceSpec:
        ws = self.cfg.workspace(ws_id)
        if not ws.enabled:
            raise KeyError(ws_id)
        return ws

    def _track_run(self, ws_id: str, old: str, new: str) -> None:
        """Container history: a run starts when a container starts and ends when
        it stops ("unknown" means podman didn't answer, so the run stays open)."""
        del old  # what counts is whether a run is open: "unknown" blips come and go
        try:
            if new == RUNNING and ws_id not in self.runs.open:
                ws = self.cfg.workspace(ws_id)
                self.runs.start(ws_id, ws.name, "local" if ws.native else "stream",
                                projects=[p["id"] for p in ws.projects])
            elif new not in (RUNNING, "unknown") and ws_id in self.runs.open:
                self.runs.end(ws_id)
        except (KeyError, OSError) as e:
            log.debug("run history %s: %s", ws_id, e)

    def _container_changed(self, old: str, new: str) -> None:
        """A container started or stopped: the tailnet serves running
        stream workspaces, so it takes another look now."""
        if self.tailnet is not None and (old == RUNNING) != (new == RUNNING):
            self.tailnet.kick()

    def _set(self, ws_id: str, **changes) -> None:
        st = self.states[ws_id]
        if "container" in changes:
            self._track_run(ws_id, st.container, changes["container"])
            self._container_changed(st.container, changes["container"])
        phase_changed = "phase" in changes and changes["phase"] != st.phase
        if phase_changed:
            st.since = time.time()
            if changes["phase"] != ERROR:
                st.error = None
            if changes["phase"] not in BUSY:
                st.progress = None
                st.message = None
                st.download = None
        for k, v in changes.items():
            setattr(st, k, v)
        # A pull reports hundreds of lines a second; publishing each one buried
        # the kiosk in SSE events. Progress is rate limited, phases are not.
        now = time.monotonic()
        if phase_changed or set(changes) - {"progress", "message"} or now - self._last_publish >= PROGRESS_PUBLISH_S:
            self._last_publish = now
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
            "autostart": ws.autostart,
            "display": ws.display,
            "image": ws.image,
            "state": self.states[ws.id].to_dict(),
        }

    def snapshot(self) -> dict:
        return {
            "machine": self.cfg.machine_name,
            "version": __version__,
            "view": self.view,
            "pending": self.pending_switch,
            "live_frames": self.cfg.shell.live_frames,
            "kiosk_connected": bool(getattr(self.kiosk, "connected", False)),
            "backend": self.backend.name,
            "backend_connected": self.backend_ok,
            "enrolled": self.enrolled,
            "cloud_enabled": self.cfg.cloud is not None,
            "hotkey_devices": len(self.hotkey_devices),
            "network": self.network,
            "wadcreator_url": self.cfg.launcher.wadcreator_url,
            "session": self.session_dict(),
            "native_display": self.display.available,
            "workspaces": [self.workspace_dict(ws) for ws in self.cfg.enabled_workspaces],
        }

    def _spawn(self, coro) -> None:
        """Fire and forget, keeping a reference so the task isn't collected."""
        task = asyncio.ensure_future(coro)
        self._bg.add(task)
        task.add_done_callback(self._bg.discard)

    def _native_id(self, view: str) -> str | None:
        """The display window key for a view drawn as its own window: a
        native workspace's id, or "app:<name>" for Wad Creator's app."""
        if view.startswith("workspace:"):
            ws = self.cfg.workspace_or_none(view.split(":", 1)[1])
            if ws is not None and ws.native:
                return ws.id
        if view.startswith("app:"):
            return view
        return None

    async def _place(self, view: str) -> None:
        """Bring the window for a view forward: its own for a native
        workspace, the kiosk's (the shell) for everything else."""
        ws_id = self._native_id(view)
        if ws_id is None or not await self.display.show_native(ws_id):
            await self.display.show_shell()

    def _show(self, view: str) -> None:
        """Put a view on screen. The shell follows self.view over SSE."""
        self._start_focus_clock(view)
        self.view = view
        self.mru = [view] + [v for v in self.mru if v != view]
        self.publish()
        self._spawn(self._place(view))

    async def recover_kiosk(self) -> None:
        """The kiosk should only ever show the shell page. If something moved
        it (a crash, a stray link), put it back."""
        try:
            url = await self.kiosk.current_url()
        except KioskUnavailable as e:
            log.debug("kiosk unreachable: %s", e)
            return
        if url and not url.startswith(self.launcher_url):
            log.info("kiosk wandered to %s; returning to the shell", url)
            try:
                await self.kiosk.navigate(self.launcher_url)
            except KioskUnavailable as e:
                log.warning("kiosk navigation failed: %s", e)

    # ------------------------------------------------------------ commands
    async def switch(self, ws_id: str) -> None:
        ws = self._ws(ws_id)
        st = self.states[ws.id]
        if st.phase == READY and st.container == RUNNING:
            self.pending_switch = None
            self._show(f"workspace:{ws.id}")
            return
        # Not ready: stay on the current view (the shell shows progress) and
        # swap once it answers, so there is no loading screen in between.
        self.pending_switch = ws.id
        self.publish()
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
                await self._pull(ws)
                if await self.backend.state(ws) != RUNNING:
                    self._set(ws.id, phase=STARTING, message="starting container")
                    await self.backend.start(ws)
                self._set(ws.id, phase=WAITING, container=RUNNING, message="waiting for the desktop")
                if ws.native:
                    await self._wait_native(ws)
                else:
                    await wait_http_ok(ws.url, self.cfg.daemon.ready_timeout_s, self.ready_poll_s)
                self._set(ws.id, phase=READY)
                log.info("%s ready%s", ws.id, "" if ws.native else f" at {ws.url}")
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001 - surfaced to the user
                log.exception("bringing up %s failed", ws.id)
                self._set(ws.id, phase=ERROR, error=str(e))
                return
        if self.pending_switch == ws.id:
            self.pending_switch = None
            self._show(f"workspace:{ws.id}")

    async def _wait_native(self, ws: WorkspaceSpec) -> None:
        """A native workspace is ready when its desktop's window appears."""
        if not self.display.available:
            log.warning("%s draws on the host compositor, but there is no sway session to show it in",
                        ws.id)
            return
        event = self.native_windows.setdefault(ws.id, asyncio.Event())
        if self.display.has_window(ws.id):
            return
        try:
            await asyncio.wait_for(event.wait(), self.cfg.daemon.ready_timeout_s)
        except asyncio.TimeoutError:
            raise TimeoutError(f"{ws.name}'s desktop did not open a window within "
                               f"{self.cfg.daemon.ready_timeout_s:.0f} s") from None

    def on_native_window(self, ws_id: str, present: bool) -> None:
        """From the display watcher: a native workspace's window came or went."""
        if ws_id.startswith("app:"):
            return self._on_app_window(ws_id, present)
        if ws_id not in self.states:
            return
        event = self.native_windows.setdefault(ws_id, asyncio.Event())
        st = self.states[ws_id]
        if present:
            event.set()
            if st.phase in (IDLE, WAITING) and not self.locks[ws_id].locked():
                self._set(ws_id, phase=READY, container=RUNNING)
            if self.view == f"workspace:{ws_id}":
                self._spawn(self._place(self.view))  # it restarted while on screen
        else:
            event.clear()
            if st.phase == READY:
                self._set(ws_id, phase=WAITING, message="the desktop closed; waiting for it to come back")

    async def resolve_window(self, owner: tuple[str, str]) -> str | None:
        """Which workspace a window's process belongs to (see sway.pid_owner)."""
        kind, value = owner
        if kind == "exe":
            return "app:wadcreator" if value == self.cfg.launcher.wadcreator_app else None
        if kind == "workspace":
            return value if value in self.states else None
        try:
            info = await self.podman.inspect_container(value)
        except Exception as e:  # noqa: BLE001
            log.debug("inspect %s: %s", value[:12], e)
            return None
        labels = ((info or {}).get("Config") or {}).get("Labels") or {}
        ws_id = labels.get("wadspaces.id")
        return ws_id if ws_id in self.states else None

    async def _pull(self, ws: WorkspaceSpec) -> None:
        """Make sure the image is present. Callers hold the workspace lock."""
        self._set(ws.id, phase=PULLING, message="checking image")
        if self.pull_slots.locked():
            self._set(ws.id, message="waiting for another download to finish")
        async with self.pull_slots:
            self._set(ws.id, phase=PULLING, message="checking image")
            progress = await self._pull_progress(ws)
            if progress:
                if not self._pulls:
                    self._rx_last = progress.rx_start
                self._pulls[ws.id] = progress
                if self._rx_task is None or self._rx_task.done():
                    self._rx_task = asyncio.create_task(self._track_pulls())

            def on_line(pct, msg):
                if progress is None:  # no sizes: show podman's own lines
                    self._set(ws.id, progress=pct, message=msg)
            try:
                await self.backend.ensure_image(ws, on_line)
            finally:
                self._pulls.pop(ws.id, None)
            if progress:
                progress.finish()
                self._set(ws.id, progress=100, download=progress.to_dict(), message="unpacking")
            if st := self.states.get(ws.id):
                st.image_present = True

    async def _pull_progress(self, ws: WorkspaceSpec) -> registry.PullProgress | None:
        """Set up a byte-based progress bar if the image has to be downloaded.
        Best effort: any failure here only means no bar."""
        try:
            if await self.podman.image_exists(ws.image):
                return None
            sizes = await asyncio.wait_for(registry.fetch_layer_sizes(ws.image), 15)
            root = await self.podman.graph_root() or self.image_store
            local = await asyncio.to_thread(registry.local_blob_digests, root)
        except Exception as e:  # noqa: BLE001
            log.info("no progress bar for %s: %s", ws.id, e)
            return None
        total = sum(size for digest, size in sizes.items() if digest not in local) if sizes else None
        log.info("pulling %s: %s to download", ws.image,
                 registry.human_bytes(total) if total is not None else "unknown size")
        return registry.PullProgress(total, layers=len(sizes or {}), rx_start=registry.rx_bytes())

    async def _track_pulls(self) -> None:
        """Every second, split the bytes that arrived between the downloads
        in progress, by how much each still has to fetch. One download gets
        them all; with several it is an estimate, but every bar moves and
        finishes when its pull does."""
        while self._pulls:
            rx = registry.rx_bytes()
            delta = max(0, rx - self._rx_last)
            self._rx_last = rx
            active = list(self._pulls.items())
            left = {i: max(1, (p.total_bytes or 0) - p.done_bytes) for i, p in active}
            weight = sum(left.values())
            for ws_id, p in active:
                p.received += int(delta * left[ws_id] / weight)
                p.sample(p.rx_start + p.received)
                self._set(ws_id, progress=p.percent, download=p.to_dict(),
                          message=registry.describe(p))
            await asyncio.sleep(self.pull_sample_s)

    async def _image_present(self, ws: WorkspaceSpec) -> bool | None:
        if not self.backend_ok:
            return None
        try:
            return await self.podman.image_exists(ws.image)
        except Exception as e:  # noqa: BLE001
            log.debug("image_exists %s: %s", ws.id, e)
            return None

    async def download(self, ws_id: str) -> None:
        """Pull a workspace's image now, from the launcher's Download button."""
        await self.prefetch(ws_id)

    async def prefetch(self, ws_id: str) -> bool:
        """Pull a workspace's image without starting it. False if it failed."""
        ws = self._ws(ws_id)
        task = self.tasks.get(ws.id)
        if task and not task.done():
            await asyncio.wait({task})  # a switch is already bringing it up
            return self.states[ws.id].phase != ERROR
        if self.states[ws.id].container == RUNNING:
            return True
        async with self.locks[ws.id]:
            before = self.states[ws.id].phase
            try:
                await self._pull(ws)
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001 - shown on the tile
                log.warning("prefetching %s failed: %s", ws.id, e)
                self._set(ws.id, phase=ERROR, error=f"download failed: {e}")
                return False
            self._set(ws.id, phase=before if before not in BUSY + (ERROR,) else IDLE)
            return True

    def disk_free_gb(self) -> float:
        path = self.image_store if os.path.isdir(self.image_store) else "/"
        return shutil.disk_usage(path).free / 1e9

    async def prefetch_loop(self, net=None, retry_s: float = 300.0) -> None:
        """Once online: bring up autostart workspaces and, with prefetch "all",
        pull the other images while at least prefetch_min_free_gb stays free.
        Failures are retried every retry_s."""
        if net is not None:
            delay = 5.0
            while (c := await net.connectivity()) not in ("full", "unknown"):
                log.info("prefetch: waiting for the network (connectivity %s)", c)
                await asyncio.sleep(delay)
                delay = min(delay * 2, 60.0)
        delay = 2.0
        while not await self.backend.available():
            log.info("prefetch: waiting for podman")
            await asyncio.sleep(delay)
            delay = min(delay * 2, 60.0)
        everything = self.cfg.daemon.prefetch == "all"
        pending = sorted((w for w in self.cfg.enabled_workspaces if w.autostart or everything),
                         key=lambda w: not w.autostart)
        while pending:
            failed = []
            for ws in pending:
                if ws.id not in self.states or not ws.enabled:
                    continue  # removed or disabled meanwhile
                if not ws.autostart and self.disk_free_gb() < self.cfg.daemon.prefetch_min_free_gb:
                    log.info("prefetch: skipping %s, under %d GB free; it downloads on first use",
                             ws.id, self.cfg.daemon.prefetch_min_free_gb)
                    continue
                if ws.autostart:
                    await self.start(ws.id)
                    await asyncio.wait({self.tasks[ws.id]})
                    ok = self.states[ws.id].phase != ERROR
                else:
                    ok = await self.prefetch(ws.id)
                if not ok:
                    failed.append(ws)
            pending = failed
            if pending:
                log.info("prefetch: retrying %s in %ds", [w.id for w in pending], retry_s)
                await asyncio.sleep(retry_s)
        log.info("prefetch: done")

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
        self.mru = [v for v in self.mru if v != f"workspace:{ws.id}"]
        if self.view == f"workspace:{ws.id}":
            # Next running session workspace; with none left, Home (even
            # though locked: there is nothing else to show).
            others = [w for w in self.session_workspaces()
                      if w != ws.id and self.states[w].container == RUNNING] if self.session_locked else []
            if others:
                await self.switch(others[0])
            else:
                await self.show_launcher(force=True)

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
            self.pending_switch = ws.id  # the shell reloads the frame once it answers again
        self._set(ws.id, phase=IDLE)
        await self.start(ws.id)

    async def show_launcher(self, force: bool = False) -> None:
        """Home (the landing page, during a session). Refused during a focus
        session unless `force` (nothing else is left to show)."""
        if self.session_locked and not force:
            raise SessionLocked()
        self.pending_switch = None
        self._show("launcher")

    def navigate_allowed(self, url: str) -> bool:
        p = urlparse(url)
        if p.scheme == "http" and p.hostname in ("127.0.0.1", "localhost"):
            return True
        return any(url == a or url.startswith(a.rstrip("/") + "/")
                   for a in self.cfg.launcher.allow_navigate + [self.cfg.launcher.wadcreator_url] if a)

    # ------------------------------------------------------ Wad Creator app
    async def open_wadcreator(self) -> None:
        """Home's Wad Creator link: the desktop app as a window of its own,
        started on first use. Without sway (dev), the page in the shell."""
        if self.session_locked:
            raise SessionLocked()
        view = "app:wadcreator"
        if not self.display.available:
            await self.navigate(self.cfg.launcher.wadcreator_url)
            return
        self.pending_switch = None
        if self.display.has_window(view):
            self._show(view)
            return
        self._app_pending = view
        if not await self.display.launch(self.cfg.launcher.wadcreator_app):
            self._app_pending = None
            raise RuntimeError("could not start Wad Creator")
        self.bus.publish({"type": "notice", "data": {"text": "Opening Wad Creator…"}})

    def _on_app_window(self, key: str, present: bool) -> None:
        if present and self._app_pending == key:
            self._app_pending = None
            self._show(key)
        elif present and self.view == key:
            self._spawn(self._place(key))
        elif not present and self.view == key:
            self._spawn(self.show_launcher(force=True))  # it was closed: back Home

    async def navigate(self, url: str) -> None:
        """Show a page (Wad Creator, an allow_navigate target) in the shell."""
        if not self.navigate_allowed(url):
            raise PermissionError(f"navigation to {url} is not allowed")
        if self.session_locked:
            raise SessionLocked()
        self.pending_switch = None
        self._show(f"url:{url}")

    # ------------------------------------------------------------- carousel
    # Super+Tab: wadd keeps the state because the shell has no keyboard focus
    # while a workspace frame is on screen. Items are most recently used
    # first, so the first Tab lands on the view you came from.
    def carousel_items(self) -> list[dict]:
        # Only what was picked on Home takes part. Before any pick that is
        # Home alone; during a focus session only the picks, with Home joining
        # once the time is up; a free session has the picks and Home.
        home = {"view": "launcher", "name": "Home", "icon": None, "running": True}
        entries: dict[str, dict] = {} if self.session_locked else {"launcher": home}
        picked = set(self.session_workspaces())
        for ws in self.cfg.enabled_workspaces:
            if ws.id not in picked:
                continue
            st = self.states[ws.id]
            entries[f"workspace:{ws.id}"] = {
                "view": f"workspace:{ws.id}",
                "name": ws.name,
                "icon": f"/api/icons/{ws.id}" if ws.icon else None,
                "running": st.container == RUNNING or st.phase == READY,
            }
        order = [v for v in self.mru if v in entries]
        order += [v for v in entries if v not in order]
        if self.view in entries and order[0] != self.view:
            order = [self.view] + [v for v in order if v != self.view]
        items = [entries[v] for v in order]
        return sorted(items, key=lambda i: not i["running"]) if len(items) > 1 else items

    def _publish_carousel(self) -> None:
        self.bus.publish({"type": "carousel", "data": self.carousel or {"open": False}})

    def carousel_step(self, direction: int = 1) -> None:
        """Open the switcher (first step lands on the previous view) or move."""
        if self.carousel is None:
            items = self.carousel_items()
            if len(items) < 2:
                return
            self.carousel = {"open": True, "items": items, "index": 1 if direction > 0 else len(items) - 1}
            # The switcher is drawn by the shell: bring it over a native window.
            if self._native_id(self.view):
                self._spawn(self.display.show_shell())
        else:
            n = len(self.carousel["items"])
            self.carousel["index"] = (self.carousel["index"] + direction) % n
        self._publish_carousel()

    async def carousel_commit(self) -> None:
        picked = self.carousel
        self.carousel = None
        self._publish_carousel()
        if not picked:
            return
        view = picked["items"][picked["index"]]["view"]
        if view == "launcher":
            await self.show_launcher()
        elif view.startswith("workspace:"):
            await self.switch(view.split(":", 1)[1])
        if self.view != view and self._native_id(self.view):
            self._spawn(self._place(self.view))  # still starting: back to where we were

    def carousel_cancel(self) -> None:
        if self.carousel is not None:
            self.carousel = None
            self._publish_carousel()
            if self._native_id(self.view):
                self._spawn(self._place(self.view))

    async def on_hotkey(self, action: str) -> None:
        try:
            if action == "launcher":
                await self.show_launcher()
            elif action.startswith("switch:"):
                await self.switch(action.split(":", 1)[1])
            elif action == "carousel_next":
                self.carousel_step(1)
            elif action == "carousel_prev":
                self.carousel_step(-1)
            elif action == "carousel_commit":
                await self.carousel_commit()
            elif action == "carousel_cancel":
                self.carousel_cancel()
        except (KeyError, SessionLocked):
            pass

    # ------------------------------------------------------------------ HUD
    # The floating Wi-Fi/power buttons (host/usr/libexec/wadspaces/hud) sit
    # above every window, but their menus live in the shell page.
    async def open_panel(self, panel: str) -> None:
        if panel not in ("wifi", "power"):
            raise ValueError(f"unknown panel {panel!r}")
        await self.display.show_shell()
        self.bus.publish({"type": "panel", "data": {"panel": panel}})

    async def panel_closed(self) -> None:
        """The menu was closed: put back whatever was on screen."""
        await self._place(self.view)

    # -------------------------------------------------------- focus session
    @property
    def session_locked(self) -> bool:
        """A focus session whose time isn't up: Home and Wad Creator wait."""
        return (bool(self.session) and self.session.get("mode", "focus") == "focus"
                and not self.session["expired"])

    def session_workspaces(self) -> list[str]:
        return [w for w in (self.session or {}).get("workspaces", []) if w in self.states]

    def session_dict(self) -> dict | None:
        if not self.session:
            return None
        ends = self.session.get("ends_at")
        return {"mode": "focus", **self.session,
                "remaining_s": None if ends is None else max(0, int(ends - time.time()))}

    @property
    def _session_file(self) -> Path:
        return Path(self.cfg.daemon.state_dir) / "session.json"

    def _save_session(self) -> None:
        try:
            if self.session is None:
                self._session_file.unlink(missing_ok=True)
            else:
                self._session_file.parent.mkdir(parents=True, exist_ok=True)
                self._session_file.write_text(json.dumps(self.session))
        except OSError as e:
            log.warning("could not save the session: %s", e)

    async def session_begin(self, ws_ids: list[str], minutes: int | None) -> dict:
        """Start a session: bring up the picked workspaces (downloading them
        first if needed) and show Home's landing page; they are one Super+Tab
        away. With `minutes` it is a focus session (Home stays out of
        Super+Tab until the time is up); without, focus was skipped."""
        if self.session_locked:
            raise SessionLocked()
        ids = list(dict.fromkeys(ws_ids))
        if not ids:
            raise ValueError("pick at least one workspace")
        for ws_id in ids:
            self._ws(ws_id)  # KeyError: unknown or disabled
        now = time.time()
        if minutes is None:
            self.session = {"workspaces": ids, "mode": "free", "started_at": now,
                            "ends_at": None, "expired": False}
            log.info("session (no focus timer): %s", ", ".join(ids))
        else:
            minutes = int(minutes)
            if not 1 <= minutes <= SESSION_MAX_MIN:
                raise ValueError(f"minutes must be 1..{SESSION_MAX_MIN}")
            # The clock starts when a pick is first opened (_start_focus_clock).
            self.session = {"workspaces": ids, "mode": "focus", "started_at": now,
                            "minutes": minutes, "ends_at": None, "expired": False}
            log.info("focus session: %s for %d min, from the first time one is opened",
                     ", ".join(ids), minutes)
        self._save_session()
        for ws_id in ids:
            await self.start(ws_id)
        await self.show_launcher(force=True)
        return self.session_dict()

    def _start_focus_clock(self, view: str) -> None:
        """A focus session's time runs from the first time one of its
        workspaces is on screen, not from when it was set up on Home."""
        s = self.session
        if (not s or s.get("mode") != "focus" or s.get("ends_at") is not None
                or not view.startswith("workspace:") or view.split(":", 1)[1] not in s["workspaces"]):
            return
        s["ends_at"] = time.time() + s["minutes"] * 60
        self._save_session()
        self._arm_session_timer()
        log.info("focus session: the clock is running (%d min)", s["minutes"])

    def _arm_session_timer(self) -> None:
        """Needs a running event loop (wadd's startup calls restore_session
        from inside it; before that, arming a timer crashed wadd)."""
        if self._session_task and not self._session_task.done():
            self._session_task.cancel()
        self._session_task = asyncio.ensure_future(self._session_timer())

    async def _session_timer(self) -> None:
        while self.session and self.session.get("ends_at") is not None and not self.session["expired"]:
            left = self.session["ends_at"] - time.time()
            if left <= 0:
                self.expire_session()
                return
            await asyncio.sleep(min(left, 60))

    def expire_session(self) -> None:
        """Time's up: Home joins Super+Tab. The picks stay until a new
        session is started from Home."""
        if not self.session or self.session["expired"]:
            return
        self.session["expired"] = True
        self._save_session()
        log.info("focus session: time is up")
        self.publish()
        self.bus.publish({"type": "notice", "data": {"text": "Time's up — Home is back in Super+Tab"}})

    def end_session(self) -> None:
        """Back to picking (Home's "New session"). Not during focus time."""
        if self.session_locked:
            raise SessionLocked()
        if self._session_task and not self._session_task.done():
            self._session_task.cancel()
        self.session = None
        self._save_session()
        self.publish()

    def restore_session(self) -> None:
        """After a restart (or reboot) mid-session, pick up where it was."""
        try:
            saved = json.loads(self._session_file.read_text())
        except FileNotFoundError:
            return
        except (OSError, ValueError) as e:
            log.warning("ignoring the saved session: %s", e)
            return
        ids = [w for w in saved.get("workspaces", []) if w in self.states]
        if not ids:
            self._save_session()
            return
        self.session = {"mode": "focus", **saved, "workspaces": ids}
        ends = self.session.get("ends_at")
        if ends is None:
            state = "no timer" if self.session["mode"] == "free" else "clock not started yet"
        elif time.time() >= ends:
            self.session["expired"] = True
            state = "time is up"
        else:
            self._arm_session_timer()
            state = f"{self.session_dict()['remaining_s'] // 60} min left"
        log.info("resumed session: %s (%s)", ", ".join(ids), state)
        self.publish()

    def hotkey_bindings(self) -> dict[int, str]:
        from .keyproxy import keycode
        b: dict[int, str] = {}
        for name in self.cfg.daemon.keys.launcher:
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
        if self.key_router is not None:
            self.key_router.bindings = self.hotkey_bindings()  # hotkeys may have changed
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
        until restarted; the result says whether that is needed. Its projects
        are a launch's business (launches.py): a spec without the key (the
        editor's, a rebuild's) keeps the ones it has."""
        old = self.cfg.workspace(ws_id)
        spec = {**spec, "id": ws_id}
        if "projects" not in spec and old.projects:
            spec["projects"] = old.projects
        await self._apply([spec if w.id == ws_id else workspace_to_dict(w) for w in self.cfg.workspaces])
        changed = workspace_to_dict(old) != self.spec_dict(ws_id)
        running = self.states[ws_id].container == RUNNING
        return {"workspace": self.spec_dict(ws_id), "restart_required": changed and running}

    async def delete_workspace(self, ws_id: str) -> None:
        ws = self.cfg.workspace(ws_id)
        if ws.enabled and self.states[ws_id].container == RUNNING:
            await self.stop(ws_id)
        await self._apply([workspace_to_dict(w) for w in self.cfg.workspaces if w.id != ws_id])

    # ------------------------------------------------------------- projects
    # The documents live in self.projects (projects.py); launches.py puts
    # their folders on disk and mounts them. Wad Creator follows changes
    # through `projects` events.
    def machine_ref(self) -> tuple[str, str]:
        """(id, name) of this machine for folder projects: its enrolled id, or
        "local" until it is enrolled."""
        cloud = self.cloud
        mid = cloud.machine_id if cloud is not None and cloud.enrolled else None
        return mid or LOCAL, self.cfg.machine_name

    def folder_here(self, source: dict) -> bool:
        """Whether a folder project's folder is this machine's."""
        mid = self.machine_ref()[0]
        return source.get("machineId") == mid or (mid == LOCAL and source.get("machineId") == LOCAL)

    def publish_projects(self, ids: list[str]) -> None:
        self.bus.publish({"type": "projects", "data": {"ids": ids}})

    def project_mounted_in(self, pid: str) -> list[str]:
        """Workspaces whose unit mounts this project."""
        return [ws.id for ws in self.cfg.workspaces if any(p["id"] == pid for p in ws.projects)]

    def mounted_projects(self) -> list[str]:
        """Projects mounted in a running container (the heartbeat publishes
        them, so a launch elsewhere can warn)."""
        return sorted({p["id"] for ws in self.cfg.workspaces if ws.id in self.states
                       and self.states[ws.id].container == RUNNING for p in ws.projects})

    async def project_status(self, pid: str) -> dict:
        """Where the folder is, whether a launch can have it (available, else
        reason), who mounts it, and its git state from the refs here (git:
        {branch, dirty, ahead, behind, upstream}, or None when the folder
        isn't a git repository). No fetch and no mounting: this has to be
        quick."""
        doc = self.projects.get(pid)  # KeyError: no such project
        src = doc.get("source") or {}
        kind = src.get("kind")
        reason = None
        path: Path | None = project_dir(self.cfg.daemon.projects_dir, pid)
        if kind == "folder":
            path = Path(src["path"])
            if not self.folder_here(src):
                path, reason = None, f"on {src.get('machineName') or src.get('machineId')}"
            elif not path.is_dir():
                reason = f"folder {src['path']} is missing"
        elif kind == "drive":
            label = src.get("label") or src.get("uuid")
            try:
                drive, mp = await self.drives.where(src["uuid"])
            except DriveError as e:
                drive, mp, reason = None, None, str(e)
            path = Path(mp, src.get("subpath") or "") if mp else None
            if drive is None:
                reason = reason or f"plug in the drive {label}"
            elif path is not None and not path.is_dir():
                reason = f"folder {src.get('subpath')} is missing on {label}"
        elif doc.get("legacy") and not path.is_dir():
            reason = "not a GitHub repo and not on this machine"
        here = path is not None and path.is_dir()
        git = await gitimport.status(path, self.cfg.daemon.projects_uid) if here else None
        # bytes: a du of a tree with node_modules is too slow for a status call.
        out = {"exists_on_disk": here, "path": str(path) if path is not None else None, "bytes": None,
               "mounted_in": self.project_mounted_in(pid), "git": git, "available": reason is None}
        if reason:
            out["reason"] = reason
        return out

    async def delete_project(self, pid: str, purge: bool = False) -> dict:
        """Tombstone a project; with purge, also remove its folder, unless a
        workspace still mounts it (ProjectConflict)."""
        self.projects.get(pid)
        if purge and (users := self.project_mounted_in(pid)):
            raise ProjectConflict(f"still mounted in {', '.join(users)}; launch "
                                  f"{'it' if len(users) == 1 else 'them'} without this project first")
        doc = self.projects.delete(pid)
        purged = await asyncio.to_thread(purge_dir, self.cfg.daemon.projects_dir, pid) if purge else False
        self.publish_projects([pid])
        return {**doc, "purged": purged}

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

    async def seed_secrets(self) -> list[str]:
        """Create podman secrets from files baked into the image
        (<secrets_dir>/podman/<name>). A secret is (re)written when it is
        missing or the baked file changed since the last seed, so a rotated
        token in a new image takes effect while `wadd secret set` overrides
        stick until the next change. Returns the names written."""
        src = Path(self.cfg.daemon.secrets_dir) / "podman"
        if not src.is_dir():
            return []
        record = Path(self.cfg.daemon.state_dir) / "seeded-secrets.json"
        try:
            seeded = json.loads(record.read_text())
        except (OSError, ValueError):
            seeded = {}
        existing = set(await self.list_secrets())
        written = []
        for f in sorted(p for p in src.iterdir() if p.is_file()):
            value = f.read_bytes()
            digest = hashlib.sha256(value).hexdigest()
            if f.name in existing and seeded.get(f.name) == digest:
                continue
            await self.podman.create_secret(f.name, value, replace=True)
            seeded[f.name] = digest
            written.append(f.name)
            log.info("seeded podman secret %s from %s", f.name, f)
        if written:
            record.parent.mkdir(parents=True, exist_ok=True)
            tmp = record.with_suffix(".tmp")
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as out:
                json.dump(seeded, out)
            os.replace(tmp, record)
        return written

    # -------------------------------------------------------------- network
    async def network_loop(self, net, interval: float = 10.0) -> None:
        while True:
            try:
                status = await net.status()
            except Exception as e:  # noqa: BLE001
                status = {"available": False, "error": str(e)}
            if status != self.network:
                self.network = status
                self.publish()
            await asyncio.sleep(interval)

    # ---------------------------------------------------------- diagnostics
    # For Wad Creator's Diagnostics page: enough to see where a download is and
    # why something failed, without SSH. Callers redact before sending.
    def log_units(self) -> list[str]:
        return ["wadd", "greetd"] + [ws.unit.removesuffix(".service") for ws in self.cfg.workspaces]

    async def unit_logs(self, unit: str, lines: int = 200) -> str:
        unit = unit.removesuffix(".service")
        if unit not in self.log_units():
            raise KeyError(unit)
        cmd = ["journalctl", "--no-pager", "-o", "short-iso", "-n", str(lines), "-u", f"{unit}.service"]
        if self.cfg.daemon.systemd_scope == "user" and unit != "greetd":
            cmd.insert(1, "--user")
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
        except FileNotFoundError:
            raise RuntimeError("journalctl is not available here") from None
        out, _ = await asyncio.wait_for(proc.communicate(), 15)
        return out.decode(errors="replace")

    async def workspace_logs(self, ws_id: str, lines: int = 200) -> str:
        ws = self.cfg.workspace(ws_id)
        return await self.podman.container_logs(ws.container_name, lines)

    async def diagnostics(self) -> dict:
        podman: dict = {"connected": self.backend_ok}
        try:
            info = await self.podman.info()
            store = info.get("store") or {}
            podman.update(version=(info.get("version") or {}).get("Version"),
                          graph_root=store.get("graphRoot"),
                          storage_driver=store.get("graphDriverName"),
                          images=(store.get("imageStore") or {}).get("number"))
        except Exception as e:  # noqa: BLE001
            podman["error"] = str(e)
        disk_path = podman.get("graph_root") or self.image_store
        if not os.path.isdir(disk_path):
            disk_path = "/"
        usage = shutil.disk_usage(disk_path)
        try:
            secrets = await self.list_secrets()
        except Exception as e:  # noqa: BLE001
            secrets = [f"(unavailable: {e})"]
        ring = logbuffer.handler()
        return {
            "wadd": {"version": __version__, "uptime_s": int(time.time() - logbuffer.STARTED),
                     "pid": os.getpid(), "config": str(self.cfg.path) if self.cfg.path else None,
                     "backend": self.backend.name},
            "podman": podman,
            "disk": {"path": disk_path, "free_bytes": usage.free, "total_bytes": usage.total},
            "network": self.network,
            "kiosk": {"connected": bool(getattr(self.kiosk, "connected", False)),
                      "view": self.view, "pending": self.pending_switch},
            "keyboards": self.hotkey_devices,
            "secrets": secrets,
            "log_units": self.log_units(),
            "workspaces": [{"id": ws.id, "name": ws.name, "image": ws.image, "enabled": ws.enabled,
                            **self.states[ws.id].to_dict()} for ws in self.cfg.workspaces
                           if ws.id in self.states],
            "recent_problems": ring.tail(30, logging.WARNING) if ring else [],
        }

    # ---------------------------------------------------------------- power
    async def power(self, action: str) -> None:
        """Shut down or reboot the machine (the kiosk has no desktop menu)."""
        if action not in ("poweroff", "reboot"):
            raise ValueError(f"unknown power action {action!r}")
        log.info("%s requested", action)
        proc = await asyncio.create_subprocess_exec(
            "systemctl", action, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
        out, _ = await proc.communicate()
        if proc.returncode != 0:
            raise RuntimeError(f"systemctl {action}: {out.decode().strip()}")

    # ------------------------------------------------------------- polling
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
                self._track_run(ws.id, st.container, container)
                self._container_changed(st.container, container)
            present = await self._image_present(ws)
            if present != st.image_present:
                new["image_present"] = present
            # WAITING too: a native workspace whose window was closed stops
            # its own container (see containers/_common svc-de).
            if container != RUNNING and st.phase in (READY, WAITING):
                new["phase"] = IDLE
            elif container == RUNNING and st.phase in (IDLE,) and (
                    self.display.has_window(ws.id) if ws.native else await http_ok(ws.url)):
                new["phase"] = READY
            if new:
                for k, v in new.items():
                    if k == "phase":
                        st.since = time.time()
                    setattr(st, k, v)
                changed = True
        await self.recover_kiosk()
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
        for t in [*self.tasks.values(), *self._bg]:
            t.cancel()
        if self._session_task:
            self._session_task.cancel()
        if self.tailnet is not None:
            await self.tailnet.client.close()
        await self.github.close()
        await self.backend.close()
        await self.kiosk.close()
