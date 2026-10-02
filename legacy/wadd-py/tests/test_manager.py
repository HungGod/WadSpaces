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
    cfg = parse_config({"daemon": {"state_dir": str(tmp_path)}, "workspaces": [
        {"id": "a", "name": "A", "image": "i", "port": 3100, "hotkey": 1},
        {"id": "b", "name": "B", "image": "i", "port": 3101, "hotkey": 2},
    ]}, tmp_path / "w.yaml")
    return WorkspaceManager(cfg, FakeBackend(), NullKiosk())


def run(coro):
    return asyncio.run(coro)


async def settle(m):
    await asyncio.gather(*m.tasks.values())


def test_cold_switch_stays_put_until_ready(mgr, monkeypatch):
    seen = []

    async def slow(url, timeout, interval=1.0):
        seen.append((mgr.view, mgr.pending_switch))  # while it comes up
    monkeypatch.setattr(manager_mod, "wait_http_ok", slow)

    async def go():
        await mgr.switch("a")
        await settle(mgr)
    run(go())
    assert seen == [("launcher", "a")]  # no loading screen in between
    assert mgr.view == "workspace:a" and mgr.pending_switch is None
    assert mgr.states["a"].phase == "ready"
    assert ("start", "a") in mgr.backend.calls
    assert mgr.kiosk.history == []  # the kiosk stays on the shell


def test_warm_switch_is_instant(mgr):
    async def go():
        await mgr.switch("a")
        await settle(mgr)
        await mgr.show_launcher()
        assert mgr.view == "launcher"
        await mgr.switch("a")
        assert mgr.view == "workspace:a"  # no await on a bring-up
    run(go())
    assert mgr.backend.calls.count(("start", "a")) == 1


def test_leaving_before_ready_does_not_steal_the_screen(mgr):
    async def go():
        await mgr.switch("a")
        await mgr.show_launcher()  # user bailed out while it was starting
        await settle(mgr)
    run(go())
    assert mgr.view == "launcher"
    assert mgr.states["a"].phase == "ready"


def test_navigate_shows_a_page_in_the_shell(mgr):
    run(mgr.navigate("http://localhost:8081/machines"))
    assert mgr.view == "url:http://localhost:8081/machines"
    with pytest.raises(PermissionError):
        run(mgr.navigate("https://example.com/"))


def test_recover_kiosk_returns_to_the_shell(mgr):
    mgr.kiosk.history.append("http://127.0.0.1:3100/")  # something moved it
    run(mgr.recover_kiosk())
    assert mgr.kiosk.history[-1] == "http://127.0.0.1:8080/"
    run(mgr.recover_kiosk())  # already home: no extra navigation
    assert len(mgr.kiosk.history) == 2


def test_carousel_without_a_session_is_home_and_what_runs(mgr):
    async def go():
        assert [i["view"] for i in mgr.carousel_items()] == ["launcher"]
        mgr.carousel_step(1)
        assert mgr.carousel is None  # nothing to switch between
        await mgr.switch("a")  # Wad Creator opened it
        await settle(mgr)
        assert [i["view"] for i in mgr.carousel_items()] == ["workspace:a", "launcher"]
        mgr.carousel_step(1)
        assert mgr.carousel["index"] == 1  # back to Wad Creator
        await mgr.carousel_commit()
    run(go())
    assert mgr.view == "launcher"


def test_carousel_starts_on_the_previous_view_and_commits(mgr):
    async def go():
        await mgr.session_begin(["a", "b"], None)
        for ws in ("a", "b"):
            await mgr.switch(ws)
            await settle(mgr)
        assert mgr.view == "workspace:b"
        mgr.carousel_step(1)
        items = [i["view"] for i in mgr.carousel["items"]]
        assert items[:2] == ["workspace:b", "workspace:a"]
        assert mgr.carousel["index"] == 1  # lands on where you came from
        mgr.carousel_step(1)
        mgr.carousel_step(-1)
        await mgr.carousel_commit()
    run(go())
    assert mgr.view == "workspace:a" and mgr.carousel is None


def test_carousel_cancel_and_stopped_last(mgr):
    async def go():
        await mgr.session_begin(["a", "b"], None)
        await settle(mgr)
        await mgr.stop("b")
        await mgr.switch("a")
        await settle(mgr)
        mgr.carousel_step(-1)  # Shift+Tab: from the end
        items = mgr.carousel["items"]
        assert items[-1]["view"] == "workspace:b" and not items[-1]["running"]
        assert mgr.carousel["index"] == len(items) - 1
        mgr.carousel_cancel()
    run(go())
    assert mgr.carousel is None and mgr.view == "workspace:a"


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


class FakeNet:
    def __init__(self, states):
        self.states = list(states)

    async def connectivity(self):
        return self.states.pop(0) if len(self.states) > 1 else self.states[0]


def test_prefetch_default_only_brings_up_autostart(mgr, monkeypatch):
    mgr.cfg.workspace("b").autostart = True
    run(mgr.prefetch_loop())
    assert mgr.backend.calls == [("ensure", "b"), ("start", "b")]  # "a" waits for first use


def test_prefetch_all_skips_when_disk_is_low(mgr, monkeypatch):
    mgr.cfg.daemon.prefetch = "all"
    mgr.disk_free_gb = lambda: 9.0
    run(mgr.prefetch_loop())
    assert mgr.backend.calls == []


def test_prefetch_starts_autostart_first_then_pulls_the_rest(mgr, monkeypatch):
    mgr.cfg.daemon.prefetch = "all"
    mgr.disk_free_gb = lambda: 100.0
    mgr.cfg.workspace("b").autostart = True
    sleeps = []

    async def fake_sleep(s):
        sleeps.append(s)
    monkeypatch.setattr(manager_mod.asyncio, "sleep", fake_sleep)
    run(mgr.prefetch_loop(FakeNet(["none", "limited", "full"])))
    assert sleeps == [5.0, 10.0]  # waited for the network with backoff
    assert mgr.backend.calls == [("ensure", "b"), ("start", "b"), ("ensure", "a")]
    assert mgr.states["b"].phase == "ready"
    assert mgr.states["a"].phase == "idle" and "a" not in mgr.backend.running
    assert mgr.kiosk.history == []  # prefetch never takes the screen


def test_prefetch_waits_for_podman(mgr, monkeypatch):
    mgr.cfg.daemon.prefetch = "all"
    mgr.disk_free_gb = lambda: 100.0
    answers = [False, False, True]

    async def available():
        return answers.pop(0)
    mgr.backend.available = available

    async def fake_sleep(s):
        assert mgr.backend.calls == []  # nothing pulled while podman is down
    monkeypatch.setattr(manager_mod.asyncio, "sleep", fake_sleep)
    run(mgr.prefetch_loop())
    assert not answers
    assert mgr.backend.calls == [("ensure", "a"), ("ensure", "b")]


def test_prefetch_retries_failures(mgr, monkeypatch):
    mgr.cfg.daemon.prefetch = "all"
    mgr.disk_free_gb = lambda: 100.0
    attempts = []

    async def flaky(ws, progress):
        attempts.append(ws.id)
        if ws.id == "a" and attempts.count("a") == 1:
            raise RuntimeError("registry down")
    mgr.backend.ensure_image = flaky

    async def fake_sleep(s):
        assert mgr.states["a"].phase == "error"
    monkeypatch.setattr(manager_mod.asyncio, "sleep", fake_sleep)
    run(mgr.prefetch_loop())
    assert attempts == ["a", "b", "a"]
    assert mgr.states["a"].phase == "idle"


class FakePodman:
    def __init__(self):
        self.secrets = {}

    async def list_secrets(self):
        return [{"Spec": {"Name": n}} for n in self.secrets]

    async def create_secret(self, name, value, replace=True):
        self.secrets[name] = value


def test_seed_secrets_only_when_missing_or_changed(mgr, tmp_path):
    (tmp_path / "secrets" / "podman").mkdir(parents=True)
    token = tmp_path / "secrets" / "podman" / "github_token"
    token.write_bytes(b"one")
    (tmp_path / "secrets" / "admin_password_hash").write_text("$6$x")  # not a podman secret
    mgr.cfg.daemon.secrets_dir = str(tmp_path / "secrets")
    mgr.cfg.daemon.state_dir = str(tmp_path / "state")
    mgr.backend.api = FakePodman()

    assert run(mgr.seed_secrets()) == ["github_token"]
    assert mgr.backend.api.secrets == {"github_token": b"one"}
    mgr.backend.api.secrets["github_token"] = b"set by hand"
    assert run(mgr.seed_secrets()) == []  # unchanged file: manual value stays
    token.write_bytes(b"two")
    assert run(mgr.seed_secrets()) == ["github_token"]  # rotated in a new image
    assert mgr.backend.api.secrets["github_token"] == b"two"
    del mgr.backend.api.secrets["github_token"]
    assert run(mgr.seed_secrets()) == ["github_token"]  # deleted: re-created
    assert oct((tmp_path / "state" / "seeded-secrets.json").stat().st_mode & 0o777) == "0o600"


def test_pull_reports_bytes_against_the_registry_sizes(mgr, monkeypatch):
    from wadd import registry

    class Api:
        async def image_exists(self, ref):
            return False

        async def graph_root(self):
            return "/nowhere"
    mgr.backend.api = Api()

    async def sizes(ref):
        return {"sha256:have": 700, "sha256:new1": 200, "sha256:new2": 100}
    monkeypatch.setattr(registry, "fetch_layer_sizes", sizes)
    monkeypatch.setattr(registry, "local_blob_digests", lambda root: {"sha256:have"})
    rx = iter([1000, 1150, 1150, 1150])
    monkeypatch.setattr(registry, "rx_bytes", lambda: next(rx, 1150))
    seen = []

    async def slow_pull(ws, progress):
        for _ in range(3):
            await asyncio.sleep(0)  # let the ticker sample
            seen.append(dict(mgr.states[ws.id].download or {}))
    mgr.backend.ensure_image = slow_pull

    run(mgr._pull(mgr.cfg.workspace("a")))
    st = mgr.states["a"]
    assert any(d.get("total_bytes") == 300 for d in seen)  # 700 already local
    assert st.download["done_bytes"] == 300 and st.progress == 100
    assert st.image_present is True


# ------------------------------------------------------------ focus sessions
@pytest.fixture
def mgr3(monkeypatch, tmp_path):
    async def instant(url, timeout, interval=1.0):
        return None
    monkeypatch.setattr(manager_mod, "wait_http_ok", instant)
    cfg = parse_config({"daemon": {"state_dir": str(tmp_path)}, "workspaces": [
        {"id": "a", "name": "A", "image": "i", "port": 3100},
        {"id": "b", "name": "B", "image": "i", "port": 3101},
        {"id": "c", "name": "C", "image": "i", "port": 3102},
    ]})
    return WorkspaceManager(cfg, FakeBackend(), NullKiosk())


def carousel_views(m):
    return [i["view"] for i in m.carousel_items()]


def test_session_narrows_the_carousel_and_locks_home(mgr3):
    mgr = mgr3

    async def go():
        await mgr.session_begin(["b", "a"], 25)
        await settle(mgr)
        assert mgr.view == "launcher"  # the landing page; picks are a Tab away
        assert mgr.backend.running == {"a", "b"}
        assert sorted(carousel_views(mgr)) == ["workspace:a", "workspace:b"]  # no Home, no C
        await mgr.switch("b")
        with pytest.raises(manager_mod.SessionLocked):
            await mgr.show_launcher()
        with pytest.raises(manager_mod.SessionLocked):
            await mgr.navigate("http://localhost:8081/")
        with pytest.raises(manager_mod.SessionLocked):
            mgr.end_session()
        assert mgr.session_locked
        await mgr.on_hotkey("launcher")  # swallowed, not raised
        assert mgr.view == "workspace:b"
        mgr.expire_session()
        assert "launcher" in carousel_views(mgr) and "workspace:c" not in carousel_views(mgr)
        await mgr.show_launcher()  # allowed now; the picks stay until a new session
        assert mgr.view == "launcher" and mgr.session is not None
        mgr.end_session()
        # No session: Home and whatever is still running.
        assert mgr.session is None and sorted(carousel_views(mgr)) == ["launcher", "workspace:a", "workspace:b"]
    run(go())


def test_a_focus_session_can_be_ended_early_when_asked(mgr3):
    async def go():
        await mgr3.session_begin(["a"], 25)
        await mgr3.switch("a")
        await settle(mgr3)
        assert mgr3.session_locked
        mgr3.end_session(force=True)
        assert mgr3.session is None and not mgr3.session_locked
        await mgr3.show_launcher()
    run(go())
    assert mgr3.view == "launcher"


def test_skipping_focus_keeps_home_in_reach(mgr3):
    mgr = mgr3

    async def go():
        await mgr.session_begin(["a"], None)
        await settle(mgr)
        assert mgr.session["mode"] == "free" and not mgr.session_locked
        assert mgr.session_dict()["remaining_s"] is None
        assert sorted(carousel_views(mgr)) == ["launcher", "workspace:a"]
        await mgr.switch("a")
        await mgr.show_launcher()
        await mgr._session_timer()  # no timer: returns at once, never expires
        assert not mgr.session["expired"]
        mgr.end_session()
        assert mgr.session is None
    run(go())


def test_session_rejects_bad_input(mgr):
    async def go():
        with pytest.raises(ValueError):
            await mgr.session_begin([], 25)
        with pytest.raises(ValueError):
            await mgr.session_begin(["a"], 0)
        with pytest.raises(KeyError):
            await mgr.session_begin(["nope"], 25)
        await mgr.session_begin(["a"], 25)
        with pytest.raises(manager_mod.SessionLocked):
            await mgr.session_begin(["b"], 25)
        await settle(mgr)
    run(go())


def test_stopping_the_shown_session_workspace_moves_to_the_next(mgr):
    async def go():
        await mgr.session_begin(["a", "b"], 25)
        await settle(mgr)
        await mgr.switch("a")
        await mgr.stop("a")
        await settle(mgr)
        assert mgr.view == "workspace:b"
        await mgr.stop("b")  # nothing left: Home, even though locked
        assert mgr.view == "launcher" and mgr.session_locked
    run(go())


def test_session_survives_a_restart(mgr, tmp_path):
    async def go():
        await mgr.session_begin(["a"], 30)
        await settle(mgr)
        await mgr.switch("a")  # starts the clock
        again = WorkspaceManager(mgr.cfg, FakeBackend(), NullKiosk())
        again.restore_session()
        assert again.session_locked and again.session["workspaces"] == ["a"]
        assert 29 * 60 <= again.session_dict()["remaining_s"] <= 30 * 60
        again.session["ends_at"] -= 3600
        again._save_session()
        late = WorkspaceManager(mgr.cfg, FakeBackend(), NullKiosk())
        late.restore_session()
        assert late.session["expired"] and not late.session_locked
        await again.close()
    run(go())


def test_focus_clock_starts_when_a_pick_is_first_opened(mgr):
    async def go():
        await mgr.session_begin(["a"], 25)
        await settle(mgr)
        assert mgr.session["ends_at"] is None and mgr.session_locked  # on the landing page
        assert mgr.session_dict()["remaining_s"] is None
        await mgr._session_timer()  # nothing to time yet
        assert not mgr.session["expired"]
        again = WorkspaceManager(mgr.cfg, FakeBackend(), NullKiosk())
        again.restore_session()  # a restart keeps it unstarted
        assert again.session["ends_at"] is None
        await mgr.switch("a")
        assert 24 * 60 < mgr.session_dict()["remaining_s"] <= 25 * 60
        first = mgr.session["ends_at"]
        await mgr.show_launcher(force=True)
        await mgr.switch("a")
        assert mgr.session["ends_at"] == first  # only the first entry counts
    run(go())


def test_the_timer_expires_the_session(mgr):
    async def go():
        await mgr.session_begin(["a"], 1)
        await settle(mgr)
        await mgr.switch("a")
        mgr.session["ends_at"] = 0  # time's up
        await mgr._session_timer()
        assert mgr.session["expired"]
    run(go())


# --------------------------------------------------------- native workspaces
class FakeDisplay:
    available = True

    def __init__(self):
        self.calls = []
        self.windows = set()

    async def show_shell(self):
        self.calls.append("shell")

    async def show_native(self, ws_id):
        self.calls.append(f"native:{ws_id}")
        return ws_id in self.windows

    def has_window(self, ws_id):
        return ws_id in self.windows

    async def launch(self, command):
        self.calls.append(f"launch:{command}")
        return True

    async def run(self, resolve, on_window):
        pass


@pytest.fixture
def native(monkeypatch, tmp_path):
    async def instant(url, timeout, interval=1.0):
        return None
    monkeypatch.setattr(manager_mod, "wait_http_ok", instant)
    cfg = parse_config({"daemon": {"state_dir": str(tmp_path), "ready_timeout_s": 2}, "workspaces": [
        {"id": "n", "name": "Native", "image": "i", "display": "host"},
        {"id": "s", "name": "Stream", "image": "i", "port": 3100},
    ]})
    m = WorkspaceManager(cfg, FakeBackend(), NullKiosk())
    m.display = FakeDisplay()
    return m


def test_native_workspace_is_ready_when_its_window_appears(native):
    async def go():
        await native.switch("n")
        await asyncio.sleep(0.05)
        assert native.states["n"].phase == "waiting" and native.view == "launcher"
        native.display.windows.add("n")
        native.on_native_window("n", True)
        await settle(native)
        await asyncio.sleep(0)
        assert native.states["n"].phase == "ready" and native.view == "workspace:n"
        assert native.display.calls[-1] == "native:n"
        native.display.windows.discard("n")
        native.on_native_window("n", False)
        assert native.states["n"].phase == "waiting"
    run(go())


def test_native_window_that_never_comes_is_an_error(native):
    async def go():
        native.cfg.daemon.ready_timeout_s = 0.05
        await native.switch("n")
        await settle(native)
    run(go())
    assert native.states["n"].phase == "error" and "did not open a window" in native.states["n"].error


def test_carousel_over_a_native_window_leaves_it_on_screen(native):
    async def go():
        native.display.windows.add("n")
        await native.session_begin(["n", "s"], None)
        await settle(native)
        await native.switch("s")
        await settle(native)
        await native.switch("n")
        await settle(native)
        await asyncio.sleep(0)
        native.display.calls.clear()
        native.carousel_step(1)
        await asyncio.sleep(0)
        assert native.display.calls == []  # the HUD draws the switcher over it
        native.carousel_cancel()
        await asyncio.sleep(0)
        assert native.display.calls[-1] == "native:n"  # back where it was
        native.carousel_step(1)
        await native.carousel_commit()  # onto the streamed one
        await asyncio.sleep(0)
        assert native.view == "workspace:s" and native.display.calls[-1] == "shell"
    run(go())


def test_parallel_downloads_split_the_bytes(mgr, monkeypatch):
    from wadd import registry

    class Api:
        async def image_exists(self, ref):
            return False

        async def graph_root(self):
            return "/nowhere"
    mgr.backend.api = Api()
    sizes = {"a": {"sha256:a": 300}, "b": {"sha256:b": 100}}

    async def fetch(ref):
        return sizes[ref]
    monkeypatch.setattr(registry, "fetch_layer_sizes", fetch)
    monkeypatch.setattr(registry, "local_blob_digests", lambda root: set())
    rx = {"n": 0}
    monkeypatch.setattr(registry, "rx_bytes", lambda: rx["n"])
    for ws in mgr.cfg.workspaces:
        ws.image = ws.id
    both_running = asyncio.Event()
    release = asyncio.Event()
    active = set()

    async def pull(ws, progress):
        active.add(ws.id)
        if len(active) == 2:
            both_running.set()
        await release.wait()
    mgr.backend.ensure_image = pull

    mgr.pull_sample_s = 0.01

    async def go():
        tasks = [asyncio.create_task(mgr.prefetch(i)) for i in ("a", "b")]
        await asyncio.wait_for(both_running.wait(), 2)  # not one at a time
        rx["n"] = 200
        await asyncio.sleep(0.05)  # a few sampler ticks
        a, b = mgr._pulls["a"], mgr._pulls["b"]
        assert a.received + b.received <= 200
        assert a.received == 150 and b.received == 50  # by what each still needs (300:100)
        release.set()
        await asyncio.gather(*tasks)
    run(go())
    assert all(mgr.states[i].image_present for i in ("a", "b"))


# ------------------------------------------------------- Wad Creator app, HUD
def test_wadcreator_opens_as_its_own_window(native):
    async def go():
        await native.open_wadcreator()
        assert native.display.calls[-1] == "launch:/usr/lib/wadcreator/wadcreator"
        assert native.view == "launcher"  # not until its window shows up
        assert await native.resolve_window(("exe", "/usr/lib/wadcreator/wadcreator")) == "app:wadcreator"
        assert await native.resolve_window(("exe", "/usr/bin/foot")) is None
        native.display.windows.add("app:wadcreator")
        native.on_native_window("app:wadcreator", True)
        await asyncio.sleep(0)
        assert native.view == "app:wadcreator" and native.display.calls[-1] == "native:app:wadcreator"
        await native.show_launcher()
        await native.open_wadcreator()  # running already: just brought back
        assert native.view == "app:wadcreator"
        assert sum(c.startswith("launch:") for c in native.display.calls) == 1
        native.display.windows.discard("app:wadcreator")
        native.on_native_window("app:wadcreator", False)  # closed: back Home
        await asyncio.sleep(0)
        assert native.view == "launcher"
        await native.session_begin(["n"], 25)
        with pytest.raises(manager_mod.SessionLocked):
            await native.open_wadcreator()
    run(go())


def test_hud_opens_a_menu_in_the_shell_and_puts_the_view_back(native):
    events = []
    q = native.bus.subscribe()

    async def go():
        native.display.windows.add("n")
        await native.session_begin(["n"], None)
        await settle(native)
        await native.switch("n")
        await asyncio.sleep(0)
        native.display.calls.clear()
        await native.open_panel("wifi")
        assert native.display.calls == ["shell"]
        while not q.empty():
            events.append(q.get_nowait())
        assert {"type": "panel", "data": {"panel": "wifi"}} in events
        await native.panel_closed()
        assert native.display.calls[-1] == "native:n"
        with pytest.raises(ValueError):
            await native.open_panel("bluetooth")
    run(go())


def test_a_saved_running_session_restores_at_startup(mgr):
    """Regression: wadd crashed at boot restoring a focus session whose clock
    was running (the timer task was created before the event loop existed).
    The restore now runs inside the loop, from wadd's startup task."""
    async def go():
        await mgr.session_begin(["a"], 30)
        await settle(mgr)
        await mgr.switch("a")  # clock running, as on the Surface
    run(go())

    async def boot():
        again = WorkspaceManager(mgr.cfg, FakeBackend(), NullKiosk())
        again.restore_session()
        assert again.session_locked and again._session_task is not None
        await again.close()
    run(boot())
