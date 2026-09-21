"""Runtime state and the event bus that feeds /api/events."""
from __future__ import annotations

import asyncio
import time
from dataclasses import asdict, dataclass, field

# Lifecycle phases shown on the launcher and splash page.
IDLE = "idle"          # not running (or unknown); nothing in progress
PULLING = "pulling"    # downloading the image
STARTING = "starting"  # container/unit starting
WAITING = "waiting"    # container up, waiting for the stream to answer HTTP
READY = "ready"        # stream answers; safe to navigate to it
STOPPING = "stopping"
ERROR = "error"
PHASES = (IDLE, PULLING, STARTING, WAITING, READY, STOPPING, ERROR)
BUSY = (PULLING, STARTING, WAITING, STOPPING)


@dataclass
class WorkspaceState:
    container: str = "unknown"  # running | exited | created | paused | missing | unknown
    phase: str = IDLE
    progress: int | None = None
    message: str | None = None
    error: str | None = None
    since: float = field(default_factory=time.time)

    def to_dict(self) -> dict:
        return asdict(self)


class EventBus:
    """Fan-out of snapshot events to any number of SSE subscribers."""

    def __init__(self) -> None:
        self._subs: set[asyncio.Queue] = set()

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=16)
        self._subs.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subs.discard(q)

    def publish(self, event: dict) -> None:
        for q in list(self._subs):
            if q.full():
                # A slow client only needs the newest snapshot.
                try:
                    q.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            q.put_nowait(event)

    @property
    def subscribers(self) -> int:
        return len(self._subs)
