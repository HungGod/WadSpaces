"""Waiting for a workspace's Selkies web server to answer."""
from __future__ import annotations

import asyncio
import time

import httpx


async def http_ok(url: str, client: httpx.AsyncClient | None = None, timeout: float = 2.0) -> bool:
    """True when the URL answers with any non-5xx status."""
    own = client is None
    client = client or httpx.AsyncClient(timeout=timeout)
    try:
        r = await client.get(url, timeout=timeout)
        return r.status_code < 500
    except (httpx.HTTPError, OSError):
        return False
    finally:
        if own:
            await client.aclose()


async def wait_http_ok(url: str, timeout: float, interval: float = 1.0) -> None:
    deadline = time.monotonic() + timeout
    async with httpx.AsyncClient(timeout=2.0) as client:
        while True:
            if await http_ok(url, client):
                return
            if time.monotonic() >= deadline:
                raise TimeoutError(f"{url} did not answer within {int(timeout)}s")
            await asyncio.sleep(interval)
