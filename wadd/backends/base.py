"""Backend protocol: how wadd starts, stops and inspects a workspace."""
from __future__ import annotations

from typing import Awaitable, Callable, Protocol

from ..config import WorkspaceSpec

# progress(percent_or_None, message)
ProgressCb = Callable[[int | None, str], None]


class BackendError(RuntimeError):
    pass


class Backend(Protocol):
    name: str

    async def available(self) -> bool: ...

    async def state(self, ws: WorkspaceSpec) -> str:
        """running | exited | created | paused | missing | unknown"""
        ...

    async def ensure_image(self, ws: WorkspaceSpec, progress: ProgressCb) -> None: ...

    async def start(self, ws: WorkspaceSpec) -> None: ...

    async def stop(self, ws: WorkspaceSpec) -> None: ...

    async def restart(self, ws: WorkspaceSpec) -> None: ...

    async def close(self) -> None: ...


AsyncFn = Callable[[], Awaitable[None]]
