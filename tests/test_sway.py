import asyncio
import json
import os
import socket

from wadd import sway
from wadd.display import SwayDisplay


def test_pack_and_read_round_trip():
    async def go():
        a, b = socket.socketpair()
        reader, _ = await asyncio.open_connection(sock=a)
        b.sendall(sway.pack(sway.RUN_COMMAND, '[{"success": true}]'))
        return await sway.read_message(reader)
    msg_type, body = asyncio.run(go())
    assert msg_type == sway.RUN_COMMAND and body == [{"success": True}]


def test_cgroup_owner():
    quadlet = "0::/system.slice/wad-writing.service/libpod-payload-" + "a" * 64 + "\n"
    assert sway.cgroup_owner(quadlet) == ("workspace", "writing")
    plain = "0::/user.slice/user-1000.slice/user@1000.service/user.slice/libpod-" + "b" * 64 + ".scope/container\n"
    assert sway.cgroup_owner(plain) == ("container", "b" * 64)
    assert sway.cgroup_owner("0::/user.slice/user-1000.slice/session-2.scope\n") is None


def test_iter_windows_finds_tiled_and_floating():
    tree = {"type": "root", "nodes": [{"type": "output", "nodes": [{"type": "workspace", "nodes": [
        {"type": "con", "id": 5, "pid": 100, "nodes": []},
        {"type": "con", "id": 6, "nodes": [{"type": "con", "id": 7, "pid": 101}]},
    ], "floating_nodes": [{"type": "floating_con", "id": 8, "pid": 102}]}]}]}
    assert [w["id"] for w in sway.iter_windows(tree)] == [5, 7, 8]


def test_find_socket_skips_dead_sways(tmp_path):
    live = tmp_path / f"sway-ipc.1000.{os.getpid()}.sock"
    dead = tmp_path / "sway-ipc.1000.999999999.sock"
    live.touch()
    dead.touch()
    assert sway.find_socket(str(tmp_path)) == str(live)
    live.unlink()
    assert sway.find_socket(str(tmp_path)) is None


class FakeIpc:
    """Answers commands and serves one window event, like a sway would."""

    def __init__(self, tree, events):
        self.tree, self.events_ = tree, events
        self.commands = []

    async def command(self, cmd):
        self.commands.append(cmd)
        return [{"success": True}]

    async def get_tree(self):
        return self.tree

    async def events(self, kinds):
        for ev in self.events_:
            yield sway.EVENT_WINDOW, ev
        raise sway.SwayUnavailable("sway went away")


def test_display_adopts_moves_and_drops_workspace_windows(monkeypatch):
    owners = {100: ("workspace", "writing"), 200: None}
    monkeypatch.setattr("wadd.display.pid_owner", lambda pid: owners.get(pid))
    tree = {"nodes": [{"type": "con", "id": 1, "pid": 200}]}  # the kiosk: not a workspace
    events = [{"change": "new", "container": {"id": 9, "pid": 100}},
              {"change": "close", "container": {"id": 9}}]
    ipc = FakeIpc(tree, events)
    seen = []

    async def resolve(owner):
        return owner[1]

    async def go():
        display = SwayDisplay(ipc, retry_s=0)
        task = asyncio.create_task(display.run(resolve, lambda ws, up: seen.append((ws, up))))
        while len(seen) < 2:
            await asyncio.sleep(0)
        task.cancel()
        return display

    display = asyncio.run(go())
    assert seen == [("writing", True), ("writing", False)]
    assert ipc.commands == ["[con_id=9] move container to workspace ws-writing, fullscreen enable"]
    assert not display.has_window("writing")


def test_request_talks_to_a_real_socket(tmp_path):
    path = str(tmp_path / "ipc.sock")

    async def go():
        async def serve(reader, writer):
            head = await reader.readexactly(sway.HEADER.size)
            _, length, msg_type = sway.HEADER.unpack(head)
            cmd = (await reader.readexactly(length)).decode()
            writer.write(sway.pack(msg_type, json.dumps([{"success": True, "cmd": cmd}])))
            await writer.drain()
            writer.close()
        server = await asyncio.start_unix_server(serve, path)
        async with server:
            return await sway.SwayIpc(socket_path=path).command("workspace shell")
    assert asyncio.run(go()) == [{"success": True, "cmd": "workspace shell"}]


def test_pid_owner_falls_back_to_the_executable(tmp_path):
    proc = tmp_path / "proc"
    (proc / "42").mkdir(parents=True)
    (proc / "42" / "cgroup").write_text("0::/user.slice/user-1000.slice/session-1.scope\n")
    (proc / "42" / "exe").symlink_to("/usr/lib/wadcreator/wadcreator")
    assert sway.pid_owner(42, str(proc)) == ("exe", "/usr/lib/wadcreator/wadcreator")
    (proc / "43").mkdir()
    (proc / "43" / "cgroup").write_text("0::/system.slice/wad-writing.service/libpod-payload-" + "a" * 64 + "\n")
    assert sway.pid_owner(43, str(proc)) == ("workspace", "writing")
