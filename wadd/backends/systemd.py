"""Production backend: quadlet units driven through systemctl.

Quadlet-managed containers must be started and stopped through systemd; a raw
`podman stop` leaves the unit failed and fights its Restart= policy. systemd
says nothing about image pulls or container details, so those come from the
podman API.
"""
from __future__ import annotations

import asyncio
import logging

from ..config import WorkspaceSpec
from .base import BackendError, ProgressCb
from .podman import PodmanApi

log = logging.getLogger(__name__)


class SystemdBackend:
    name = "systemd"

    def __init__(self, api: PodmanApi, scope: str = "system") -> None:
        self.api = api
        self.scope = scope

    async def _systemctl(self, *args: str, timeout: float = 900.0) -> str:
        cmd = ["systemctl"]
        if self.scope == "user":
            cmd.append("--user")
        cmd += list(args)
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            out, err = await asyncio.wait_for(proc.communicate(), timeout)
        except asyncio.TimeoutError:
            proc.kill()
            raise BackendError(f"{' '.join(cmd)} timed out")
        if proc.returncode != 0:
            raise BackendError(f"{' '.join(cmd)} failed: {(err or out).decode().strip()}")
        return out.decode()

    async def available(self) -> bool:
        return await self.api.ping()

    async def state(self, ws: WorkspaceSpec) -> str:
        # Quadlet runs containers with --rm, so a stopped unit means "missing".
        return await self.api.container_status(ws.container_name)

    async def ensure_image(self, ws: WorkspaceSpec, progress: ProgressCb) -> None:
        if await self.api.image_exists(ws.image):
            return
        if ws.image.startswith("localhost/"):
            raise BackendError(f"image {ws.image} is local-only and not present; build it first")
        progress(None, f"pulling {ws.image}")
        await self.api.pull(ws.image, progress)

    async def start(self, ws: WorkspaceSpec) -> None:
        await self._systemctl("start", ws.unit)

    async def stop(self, ws: WorkspaceSpec) -> None:
        await self._systemctl("stop", ws.unit, timeout=120.0)

    async def restart(self, ws: WorkspaceSpec) -> None:
        await self._systemctl("restart", ws.unit)

    async def daemon_reload(self) -> None:
        await self._systemctl("daemon-reload", timeout=60.0)

    async def close(self) -> None:
        await self.api.close()
