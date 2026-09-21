"""Steering the kiosk Chromium through the Chrome DevTools Protocol.

Chromium runs with --remote-debugging-port=9222 on loopback. Do NOT add
--remote-allow-origins: Chromium's Origin check is what stops a page loaded
in the kiosk from opening the debugging socket. This client sends no Origin
header, which Chromium accepts.
"""
from __future__ import annotations

import asyncio
import itertools
import json
import logging
from typing import Protocol

import httpx

try:  # websockets >= 13
    from websockets.asyncio.client import connect as ws_connect
except ImportError:  # pragma: no cover - older websockets
    from websockets import connect as ws_connect  # type: ignore

log = logging.getLogger(__name__)


class KioskUnavailable(RuntimeError):
    pass


class Kiosk(Protocol):
    connected: bool

    async def navigate(self, url: str) -> None: ...

    async def current_url(self) -> str | None: ...

    async def close(self) -> None: ...


class CdpClient:
    def __init__(self, base_url: str = "http://127.0.0.1:9222", timeout: float = 5.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.http = httpx.AsyncClient(timeout=3.0)
        self.connected = False
        self._ids = itertools.count(1)
        self._lock = asyncio.Lock()

    async def close(self) -> None:
        await self.http.aclose()

    async def page_target(self) -> dict | None:
        try:
            r = await self.http.get(f"{self.base_url}/json/list")
            r.raise_for_status()
            targets = r.json()
        except (httpx.HTTPError, OSError, ValueError):
            self.connected = False
            return None
        pages = [t for t in targets if t.get("type") == "page" and t.get("webSocketDebuggerUrl")]
        self.connected = bool(pages)
        return pages[0] if pages else None

    async def call(self, method: str, params: dict | None = None) -> dict:
        target = await self.page_target()
        if target is None:
            raise KioskUnavailable(f"no page target at {self.base_url}")
        msg_id = next(self._ids)
        async with self._lock:
            try:
                async with ws_connect(target["webSocketDebuggerUrl"], max_size=None,
                                      open_timeout=self.timeout) as ws:
                    await ws.send(json.dumps({"id": msg_id, "method": method, "params": params or {}}))
                    while True:
                        raw = await asyncio.wait_for(ws.recv(), self.timeout)
                        msg = json.loads(raw)
                        if msg.get("id") == msg_id:
                            if "error" in msg:
                                raise KioskUnavailable(f"{method}: {msg['error']}")
                            return msg.get("result") or {}
            except (OSError, asyncio.TimeoutError) as e:
                self.connected = False
                raise KioskUnavailable(f"{method}: {e}") from e

    async def navigate(self, url: str) -> None:
        log.info("kiosk -> %s", url)
        await self.call("Page.navigate", {"url": url})

    async def current_url(self) -> str | None:
        target = await self.page_target()
        return target.get("url") if target else None


class NullKiosk:
    """No kiosk attached (tests, or --no-cdp). Records navigations."""

    def __init__(self) -> None:
        self.connected = False
        self.history: list[str] = []

    async def navigate(self, url: str) -> None:
        log.info("kiosk (null) -> %s", url)
        self.history.append(url)

    async def current_url(self) -> str | None:
        return self.history[-1] if self.history else None

    async def close(self) -> None:
        pass
