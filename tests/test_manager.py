import asyncio

import pytest

from wadd.config import ConfigError, parse_config
from wadd.kiosk import NullKiosk
from wadd.manager import WorkspaceManager
from wadd import manager as manager_mod


class FakeBackend:
    name = "podman"

    def __init__(self):
        self.running = set()
        self.calls = []
        self.fail = None

    async def available(self):
        return True

    async def state(self, ws):
        return "running" if ws.id in self.running else "missing"

    async def ensure_image(self, ws, progress):
        self.calls.append(("ensure", ws.id))
        if self.fail:
            raise RuntimeError(self.fail)
        progress(None, "ok")

    async def start(self, ws):
        self.calls.append(("start", ws.id))
        self.running.add(ws.id)

    async def stop(self, ws):
        self.calls.append(("stop", ws.id))
        self.running.discard(ws.id)

    async def restart(self, ws):
        self.calls.append(("restart", ws.id))

    async def close(self):
        pass


@pytest.fixture
def mgr(monkeypatch, tmp_path):
    async def instant(url, timeout, interval=1.0):
        return None
    monkeypatch.setattr(manager_mod, "wait_http_ok", instant)
    cfg = parse_config({"workspaces": [
        {"id": "a", "name": "A", "image": "i", "port": 3100, "hotkey": 1},
        {"id": "b", "name": "B", "image": "i", "port": 3101, "hotkey": 2},
    ]}, tmp_path / "w.yaml")
    return WorkspaceManager(cfg, FakeBackend(), NullKiosk())


def run(coro):
    return asyncio.run(coro)


async def settle(m):
    await asyncio.gather(*m.tasks.values())


def test_cold_switch_goes_through_splash(mgr):
    async def go():
        await mgr.switch("a")
        await settle(mgr)
    run(go())
    assert mgr.kiosk.history == ["http://127.0.0.1:8080/starting/a", "http://127.0.0.1:3100/"]
    assert mgr.states["a"].phase == "ready"
    assert mgr.view == "workspace:a"
    assert ("start", "a") in mgr.backend.calls


def test_warm_switch_navigates_directly(mgr):
    async def go():
        await mgr.switch("a")
        await settle(mgr)
        await mgr.show_launcher()
        await mgr.switch("a")
    run(go())
    assert mgr.kiosk.history[-2:] == ["http://127.0.0.1:8080/", "http://127.0.0.1:3100/"]
    assert mgr.backend.calls.count(("start", "a")) == 1


def test_leaving_before_ready_does_not_steal_the_screen(mgr):
    async def go():
        await mgr.switch("a")
        await mgr.show_launcher()  # user bailed out while it was starting
        await settle(mgr)
    run(go())
    assert mgr.kiosk.history[-1] == "http://127.0.0.1:8080/"
    assert mgr.states["a"].phase == "ready"


def test_failure_sets_error(mgr):
    mgr.backend.fail = "no image"
    async def go():
        await mgr.switch("b")
        await settle(mgr)
    run(go())
    assert mgr.states["b"].phase == "error"
    assert mgr.states["b"].error == "no image"


def test_stop_returns_to_launcher(mgr):
    async def go():
        await mgr.switch("a")
        await settle(mgr)
        await mgr.stop("a")
    run(go())
    assert mgr.states["a"].phase == "idle"
    assert mgr.view == "launcher"


def test_hotkey_bindings_and_navigate_allowlist(mgr):
    b = mgr.hotkey_bindings()
    assert b[2] == "switch:a" and b[3] == "switch:b" and b[11] == "launcher"
    assert mgr.navigate_allowed("http://127.0.0.1:3100/")
    assert mgr.navigate_allowed("http://localhost:8081/machines")
    assert not mgr.navigate_allowed("https://example.com/")


def test_crud_persists(mgr):
    async def go():
        await mgr.create_workspace({"id": "c", "name": "C", "image": "i", "port": 3102})
        with pytest.raises(ConfigError):
            await mgr.create_workspace({"id": "d", "name": "D", "image": "i", "port": 3102})
        res = await mgr.update_workspace("c", {"name": "C2", "image": "i", "port": 3103})
        assert res["restart_required"] is False
        await mgr.delete_workspace("a")
    run(go())
    text = mgr.cfg.path.read_text()
    assert "name: C2" in text and "id: a\n" not in text
    assert [w.id for w in mgr.cfg.workspaces] == ["b", "c"]
    assert "a" not in mgr.states
