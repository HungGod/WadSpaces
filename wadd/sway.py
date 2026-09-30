"""A small client for sway's IPC (the i3 protocol), and the bits of /proc that
tie a window to the workspace container that drew it.

Wire format: "i3-ipc" + <u32 payload length> + <u32 type> + JSON payload,
native byte order. Events come back with the high bit of the type set.
"""
from __future__ import annotations

import asyncio
import glob
import json
import os
import re
import struct
from collections.abc import AsyncIterator, Iterator

MAGIC = b"i3-ipc"
HEADER = struct.Struct("=6sII")
RUN_COMMAND = 0
SUBSCRIBE = 2
GET_TREE = 4
EVENT_BIT = 0x80000000
EVENT_WINDOW = EVENT_BIT | 3

# The kiosk user's runtime dir; wadd.service bind-mounts it in (the host pins
# that user to uid 1000, see host/etc/sysusers.d/wadspaces.conf).
RUNTIME_DIR = "/run/user/1000"
SOCKET_RE = re.compile(r"sway-ipc\.\d+\.(\d+)\.sock$")


class SwayUnavailable(RuntimeError):
    pass


def pack(msg_type: int, payload: str | bytes = b"") -> bytes:
    body = payload.encode() if isinstance(payload, str) else payload
    return HEADER.pack(MAGIC, len(body), msg_type) + body


async def read_message(reader: asyncio.StreamReader) -> tuple[int, object]:
    head = await reader.readexactly(HEADER.size)
    magic, length, msg_type = HEADER.unpack(head)
    if magic != MAGIC:
        raise SwayUnavailable("not an i3-ipc reply")
    body = await reader.readexactly(length)
    return msg_type, json.loads(body or b"null")


def find_socket(runtime_dir: str = RUNTIME_DIR) -> str | None:
    """The socket of a sway that is still running (stale ones from an earlier
    session stay behind in the runtime dir), newest first."""
    best: tuple[float, str] | None = None
    for path in glob.glob(os.path.join(runtime_dir, "sway-ipc.*.sock")):
        m = SOCKET_RE.search(path)
        if not m or not os.path.exists(f"/proc/{m.group(1)}"):
            continue
        try:
            mtime = os.stat(path).st_mtime
        except OSError:
            continue
        if best is None or mtime > best[0]:
            best = (mtime, path)
    return best[1] if best else None


class SwayIpc:
    def __init__(self, runtime_dir: str = RUNTIME_DIR, socket_path: str | None = None) -> None:
        self.runtime_dir = runtime_dir
        self.socket_path = socket_path
        self._lock = asyncio.Lock()

    def _path(self) -> str:
        path = self.socket_path or find_socket(self.runtime_dir)
        if not path:
            raise SwayUnavailable(f"no running sway in {self.runtime_dir}")
        return path

    async def _open(self) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
        try:
            return await asyncio.open_unix_connection(self._path())
        except OSError as e:
            raise SwayUnavailable(str(e)) from e

    async def request(self, msg_type: int, payload: str = "") -> object:
        async with self._lock:
            reader, writer = await self._open()
            try:
                writer.write(pack(msg_type, payload))
                await writer.drain()
                _, reply = await asyncio.wait_for(read_message(reader), 5)
                return reply
            except (OSError, asyncio.IncompleteReadError, asyncio.TimeoutError) as e:
                raise SwayUnavailable(str(e)) from e
            finally:
                writer.close()

    async def command(self, cmd: str) -> list[dict]:
        reply = await self.request(RUN_COMMAND, cmd)
        return reply if isinstance(reply, list) else []

    async def get_tree(self) -> dict:
        reply = await self.request(GET_TREE)
        return reply if isinstance(reply, dict) else {}

    async def events(self, kinds: list[str]) -> AsyncIterator[tuple[int, dict]]:
        """Subscribe and yield (type, event) until the connection drops."""
        reader, writer = await self._open()
        try:
            writer.write(pack(SUBSCRIBE, json.dumps(kinds)))
            await writer.drain()
            _, ok = await read_message(reader)
            if not (isinstance(ok, dict) and ok.get("success")):
                raise SwayUnavailable(f"subscribe refused: {ok}")
            while True:
                try:
                    msg_type, event = await read_message(reader)
                except (OSError, asyncio.IncompleteReadError) as e:
                    raise SwayUnavailable(str(e)) from e
                if isinstance(event, dict):
                    yield msg_type, event
        finally:
            writer.close()


def iter_windows(node: dict) -> Iterator[dict]:
    """Every client window in a get_tree() result."""
    if node.get("pid") and node.get("type") in ("con", "floating_con"):
        yield node
    for child in node.get("nodes", []) + node.get("floating_nodes", []):
        yield from iter_windows(child)


# A quadlet's container lives in its unit's cgroup
# (/system.slice/wad-writing.service/libpod-payload-<id>); a plain `podman run`
# in a libpod-<id>.scope.
UNIT_RE = re.compile(r"/wad-([a-z0-9][a-z0-9-]*)\.service(?:/|$)")
CTR_RE = re.compile(r"libpod-(?:payload-)?([0-9a-f]{64})")


def cgroup_owner(cgroup: str) -> tuple[str, str] | None:
    """("workspace", id) or ("container", full id) for a /proc/<pid>/cgroup text."""
    if m := UNIT_RE.search(cgroup):
        return "workspace", m.group(1)
    if m := CTR_RE.search(cgroup):
        return "container", m.group(1)
    return None


def pid_owner(pid: int, proc: str = "/proc") -> tuple[str, str] | None:
    """("workspace"|"container", ...) for a workspace container's window, else
    ("exe", path) for a program run in the session itself (Wad Creator)."""
    try:
        with open(f"{proc}/{pid}/cgroup", encoding="utf-8") as f:
            owner = cgroup_owner(f.read())
    except OSError:
        return None
    if owner is not None:
        return owner
    try:
        return "exe", os.readlink(f"{proc}/{pid}/exe")
    except OSError:
        return None
