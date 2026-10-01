"""Putting a view on screen.

Streamed workspaces, Home and Wad Creator are all drawn by the kiosk's shell
page, so for them the display just shows the shell. A native workspace
(display: host) is its own window on the host compositor: sway gives it a
workspace of its own ("ws-<id>") and focusing that window puts it on screen.

The host's sway config assigns every new non-Chromium window to a hidden
"pending" workspace, so a container's desktop never grabs the screen while it
starts; the watcher here moves it to ws-<id> and tells the manager.

On a machine without sway (a dev laptop, the cage-based VM image) NullDisplay
stands in and native workspaces can't be shown.
"""
from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable

from .sway import EVENT_WINDOW, SwayIpc, SwayUnavailable, iter_windows, pid_owner

log = logging.getLogger(__name__)
SHELL_WORKSPACE = "shell"

# (window kind, id) from sway.pid_owner -> workspace id, or None
Resolver = Callable[[tuple[str, str]], Awaitable[str | None]]
WindowCallback = Callable[[str, bool], None]


class NullDisplay:
    available = False

    async def show_shell(self) -> None:
        pass

    async def show_native(self, ws_id: str) -> bool:
        return False

    def has_window(self, ws_id: str) -> bool:
        return False

    async def launch(self, command: str) -> bool:
        return False

    async def run(self, resolve: Resolver, on_window: WindowCallback) -> None:
        pass


class SwayDisplay:
    def __init__(self, ipc: SwayIpc | None = None, retry_s: float = 2.0) -> None:
        self.ipc = ipc or SwayIpc()
        self.retry_s = retry_s
        self.windows: dict[str, int] = {}  # workspace id -> sway con_id
        self.available = False

    async def _cmd(self, cmd: str) -> bool:
        try:
            replies = await self.ipc.command(cmd)
        except SwayUnavailable as e:
            log.debug("sway %r: %s", cmd, e)
            return False
        ok = all(r.get("success") for r in replies) if replies else False
        if not ok:
            log.warning("sway %r: %s", cmd, replies)
        return ok

    async def show_shell(self) -> None:
        await self._cmd(f"workspace {SHELL_WORKSPACE}")

    async def show_native(self, ws_id: str) -> bool:
        con = self.windows.get(ws_id)
        if con is None:
            return False
        return await self._cmd(f"[con_id={con}] focus")

    def has_window(self, ws_id: str) -> bool:
        return ws_id in self.windows

    async def launch(self, command: str) -> bool:
        """Start a program in the kiosk session (sway's environment)."""
        return await self._cmd(f"exec {command}")

    async def _adopt(self, con: dict, resolve: Resolver, on_window: WindowCallback) -> None:
        owner = pid_owner(int(con["pid"]))
        if owner is None:
            return
        ws_id = await resolve(owner)
        if ws_id is None:
            return
        con_id = int(con["id"])
        if self.windows.get(ws_id) == con_id:
            return
        # One window per workspace: the container's labwc. A second one (it
        # restarted before the old window went) replaces it.
        self.windows[ws_id] = con_id
        workspace = "ws-" + ws_id.replace(":", "-")
        await self._cmd(f"[con_id={con_id}] move container to workspace {workspace}, fullscreen enable")
        log.info("native window for %s (con %d)", ws_id, con_id)
        on_window(ws_id, True)

    def _drop(self, con_id: int, on_window: WindowCallback) -> None:
        for ws_id, known in list(self.windows.items()):
            if known == con_id:
                del self.windows[ws_id]
                log.info("native window for %s closed", ws_id)
                on_window(ws_id, False)

    async def run(self, resolve: Resolver, on_window: WindowCallback) -> None:
        """Track workspace windows for as long as wadd runs, reconnecting when
        the kiosk session (and so sway) restarts."""
        while True:
            try:
                tree = await self.ipc.get_tree()
                self.available = True
                seen = set()
                for con in iter_windows(tree):
                    seen.add(int(con["id"]))
                    await self._adopt(con, resolve, on_window)
                for con_id in [c for c in self.windows.values() if c not in seen]:
                    self._drop(con_id, on_window)
                async for msg_type, ev in self.ipc.events(["window"]):
                    if msg_type != EVENT_WINDOW:
                        continue
                    con = ev.get("container") or {}
                    if ev.get("change") == "new" and con.get("pid"):
                        await self._adopt(con, resolve, on_window)
                    elif ev.get("change") == "close" and "id" in con:
                        self._drop(int(con["id"]), on_window)
            except SwayUnavailable as e:
                if self.available:
                    log.info("lost sway: %s", e)
                self.available = False
                for con_id in list(self.windows.values()):
                    self._drop(con_id, on_window)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - keep watching
                log.exception("sway watcher failed")
                self.available = False
            await asyncio.sleep(self.retry_s)
