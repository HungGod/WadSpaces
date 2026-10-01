"""Podman REST API over its unix socket, and the dev-mode backend.

No podman-py dependency: the libpod API is plain HTTP + JSON.
"""
from __future__ import annotations

import json
import logging
import re
from urllib.parse import quote

import httpx

from ..config import WorkspaceSpec
from .base import BackendError, ProgressCb

log = logging.getLogger(__name__)
API_VERSION = "v5.0.0"


class PodmanError(BackendError):
    pass


def demux_logs(data: bytes) -> str:
    """Podman frames non-TTY logs as [stream, 0, 0, 0, size(4, big endian)]
    + payload; TTY logs are raw. Returns the text either way."""
    out, i = [], 0
    while i + 8 <= len(data) and data[i] in (0, 1, 2) and data[i + 1:i + 4] == b"\0\0\0":
        size = int.from_bytes(data[i + 4:i + 8], "big")
        out.append(data[i + 8:i + 8 + size])
        i += 8 + size
    if i == 0:
        return data.decode(errors="replace")
    out.append(data[i:])
    return b"".join(out).decode(errors="replace")


class PodmanApi:
    def __init__(self, socket_path: str) -> None:
        self.socket_path = socket_path
        self.client = httpx.AsyncClient(
            transport=httpx.AsyncHTTPTransport(uds=socket_path),
            base_url=f"http://d/{API_VERSION}/libpod",
            timeout=httpx.Timeout(30.0, read=120.0),
        )

    async def close(self) -> None:
        await self.client.aclose()

    @staticmethod
    def _err(r: httpx.Response, what: str) -> PodmanError:
        try:
            msg = r.json().get("message") or r.text
        except Exception:
            msg = r.text
        return PodmanError(f"{what}: HTTP {r.status_code}: {msg.strip()}")

    async def ping(self) -> bool:
        try:
            r = await self.client.get("/_ping", timeout=3.0)
            return r.status_code == 200
        except (httpx.HTTPError, OSError):
            return False

    async def info(self) -> dict:
        r = await self.client.get("/info")
        if r.status_code != 200:
            raise self._err(r, "info")
        return r.json()

    async def graph_root(self) -> str | None:
        """Where podman keeps images (for reading which layers it has)."""
        try:
            return ((await self.info()).get("store") or {}).get("graphRoot") or None
        except PodmanError:
            return None

    async def container_logs(self, name: str, tail: int = 200) -> str:
        """stdout+stderr of a container, last `tail` lines."""
        r = await self.client.get(f"/containers/{quote(name, safe='')}/logs",
                                  params={"stdout": "true", "stderr": "true", "tail": str(tail)})
        if r.status_code == 404:
            raise PodmanError(f"no container {name} (is the workspace running?)")
        if r.status_code != 200:
            raise self._err(r, f"logs {name}")
        return demux_logs(r.content)

    async def inspect_container(self, name: str) -> dict | None:
        r = await self.client.get(f"/containers/{quote(name, safe='')}/json")
        if r.status_code == 404:
            return None
        if r.status_code != 200:
            raise self._err(r, f"inspect {name}")
        return r.json()

    async def container_status(self, name: str) -> str:
        info = await self.inspect_container(name)
        if info is None:
            return "missing"
        return str((info.get("State") or {}).get("Status") or "unknown").lower()

    async def image_exists(self, ref: str) -> bool:
        r = await self.client.get(f"/images/{quote(ref, safe='')}/exists")
        if r.status_code in (200, 204):
            return True
        if r.status_code == 404:
            return False
        raise self._err(r, f"image exists {ref}")

    async def pull(self, ref: str, progress: ProgressCb | None = None) -> None:
        """Pull an image, reporting layer progress from the streamed JSON lines."""
        blobs_seen: set[str] = set()
        async with self.client.stream(
            "POST", "/images/pull", params={"reference": ref, "policy": "missing"},
            timeout=httpx.Timeout(30.0, read=None),
        ) as r:
            if r.status_code != 200:
                await r.aread()
                raise self._err(r, f"pull {ref}")
            async for line in r.aiter_lines():
                if not line.strip():
                    continue
                try:
                    msg = json.loads(line)
                except ValueError:
                    continue
                if msg.get("error"):
                    raise PodmanError(f"pull {ref}: {msg['error']}")
                text = (msg.get("stream") or "").strip()
                if text and progress:
                    m = re.search(r"Copying blob (?:sha256:)?([0-9a-f]{8,})", text)
                    if m:
                        blobs_seen.add(m.group(1)[:12])
                    progress(None, f"{text[:80]} ({len(blobs_seen)} layers)")

    async def build(self, context: bytes, tag: str, buildargs: dict[str, str] | None = None,
                    on_line=None) -> str:
        """Build an image from a tar build context; returns the image id.

        Each output line goes to on_line(text). podman answers 200 even when the
        build fails, so errors come from the stream. Closing the stream (cancelling
        the task) aborts the build (spike S4)."""
        params = {"t": tag, "layers": "true", "rm": "true", "forcerm": "true", "pull": "false",
                  "buildargs": json.dumps(buildargs or {})}
        image_id = ""
        async with self.client.stream(
            "POST", "/build", params=params, content=context,
            headers={"Content-Type": "application/x-tar"},
            timeout=httpx.Timeout(30.0, read=None),
        ) as r:
            if r.status_code != 200:
                await r.aread()
                raise self._err(r, f"build {tag}")
            async for line in r.aiter_lines():
                if not line.strip():
                    continue
                try:
                    msg = json.loads(line)
                except ValueError:
                    continue
                err = (msg.get("errorDetail") or {}).get("message") or msg.get("error")
                if err:
                    raise PodmanError(err.strip())
                text = msg.get("stream") or ""
                if re.fullmatch(r"[0-9a-f]{64}\s*", text):
                    image_id = text.strip()
                    continue
                for part in text.rstrip("\n").split("\n"):
                    if on_line:
                        on_line(part)
        return image_id

    async def remove_image(self, ref: str) -> bool:
        r = await self.client.delete(f"/images/{quote(ref, safe='')}")
        if r.status_code == 404:
            return False
        if r.status_code not in (200, 204):
            raise self._err(r, f"remove image {ref}")
        return True

    async def image_id(self, ref: str) -> str | None:
        r = await self.client.get(f"/images/{quote(ref, safe='')}/json")
        if r.status_code == 404:
            return None
        if r.status_code != 200:
            raise self._err(r, f"inspect image {ref}")
        return r.json().get("Id")

    async def inspect_image(self, ref: str) -> dict | None:
        r = await self.client.get(f"/images/{quote(ref, safe='')}/json")
        if r.status_code == 404:
            return None
        if r.status_code != 200:
            raise self._err(r, f"inspect image {ref}")
        return r.json()

    async def image_labels(self, ref: str) -> dict[str, str] | None:
        """An image's labels; None if it isn't here."""
        info = await self.inspect_image(ref)
        if info is None:
            return None
        return info.get("Labels") or (info.get("Config") or {}).get("Labels") or {}

    async def volume_mountpoint(self, name: str) -> str | None:
        """Where a named volume's files are on the host; None if there's no such volume."""
        r = await self.client.get(f"/volumes/{quote(name, safe='')}/json")
        if r.status_code == 404:
            return None
        if r.status_code != 200:
            raise self._err(r, f"inspect volume {name}")
        return r.json().get("Mountpoint") or None

    async def _post(self, path: str, what: str, ok=(200, 204, 304), **params) -> None:
        r = await self.client.post(path, params=params or None)
        if r.status_code not in ok:
            raise self._err(r, what)

    async def start_container(self, name: str) -> None:
        await self._post(f"/containers/{quote(name, safe='')}/start", f"start {name}")

    async def stop_container(self, name: str, timeout: int = 10) -> None:
        await self._post(f"/containers/{quote(name, safe='')}/stop", f"stop {name}", timeout=timeout)

    async def restart_container(self, name: str, timeout: int = 10) -> None:
        await self._post(f"/containers/{quote(name, safe='')}/restart", f"restart {name}", timeout=timeout)

    # --- secrets -----------------------------------------------------------
    async def list_secrets(self) -> list[dict]:
        r = await self.client.get("/secrets/json")
        if r.status_code != 200:
            raise self._err(r, "list secrets")
        return r.json() or []

    async def delete_secret(self, name: str) -> bool:
        r = await self.client.delete(f"/secrets/{quote(name, safe='')}")
        if r.status_code == 404:
            return False
        if r.status_code not in (200, 204):
            raise self._err(r, f"delete secret {name}")
        return True

    async def secret_value(self, name: str) -> str | None:
        """A secret's value, for wadd's own use (git import); never sent out."""
        r = await self.client.get(f"/secrets/{quote(name, safe='')}/json", params={"showsecret": "true"})
        if r.status_code == 404:
            return None
        if r.status_code != 200:
            raise self._err(r, f"read secret {name}")
        return r.json().get("SecretData")

    async def create_secret(self, name: str, value: bytes, replace: bool = True) -> None:
        if replace:
            await self.delete_secret(name)
        r = await self.client.post("/secrets/create", params={"name": name}, content=value)
        if r.status_code not in (200, 201):
            raise self._err(r, f"create secret {name}")


class PodmanBackend:
    """Dev backend: drives containers created by podman-compose directly.

    Create them once with `podman-compose up --no-start` (or `up -d`) in the
    workspace directory; the compose files name them wad-<id>.
    """

    name = "podman"

    def __init__(self, api: PodmanApi) -> None:
        self.api = api

    async def available(self) -> bool:
        return await self.api.ping()

    async def state(self, ws: WorkspaceSpec) -> str:
        return await self.api.container_status(ws.container_name)

    async def ensure_image(self, ws: WorkspaceSpec, progress: ProgressCb) -> None:
        if await self.api.inspect_container(ws.container_name) is None:
            raise BackendError(
                f"container {ws.container_name} does not exist; create it with "
                f"`podman-compose up --no-start` in its workspace directory")

    async def start(self, ws: WorkspaceSpec) -> None:
        await self.api.start_container(ws.container_name)

    async def stop(self, ws: WorkspaceSpec) -> None:
        await self.api.stop_container(ws.container_name)

    async def restart(self, ws: WorkspaceSpec) -> None:
        await self.api.restart_container(ws.container_name)

    async def close(self) -> None:
        await self.api.close()
