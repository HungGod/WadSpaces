"""Tailscale: the LocalAPI over a fake transport, the CLI as a fake script,
and serving stream workspaces on the tailnet."""
import asyncio
import os
import stat

import httpx
import pytest

from wadd.config import parse_config
from wadd.kiosk import NullKiosk
from wadd.manager import WorkspaceManager
from wadd.tailnet import Tailnet, TailnetWatch, parse_status, served_ports
from test_manager import FakeBackend

STATUS = {
    "BackendState": "Running",
    "TailscaleIPs": ["100.101.102.103", "fd7a:115c:a1e0::1"],
    "Self": {"ID": "nAbC123CNTRL", "HostName": "surface", "DNSName": "surface.tail1234.ts.net.",
             "TailscaleIPs": ["fd7a:115c:a1e0::1", "100.101.102.103"], "UserID": 42, "Online": True},
    "User": {"42": {"ID": 42, "LoginName": "doug@example.com"}},
}
SERVE_CONFIG = {
    "TCP": {"3100": {"HTTPS": True}, "9999": {"HTTPS": True}},
    "Web": {"surface.tail1234.ts.net:3100": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:3100"}}},
            "surface.tail1234.ts.net:9999": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:8000"}}}},
}


def localapi(status=STATUS, whois=None):
    seen = []

    def handler(req: httpx.Request) -> httpx.Response:
        assert req.url.host == "local-tailscaled.sock"
        seen.append(str(req.url))
        path = req.url.path
        if path == "/localapi/v0/status":
            return httpx.Response(200, json=status)
        if path == "/localapi/v0/whois":
            hit = (whois or {}).get(req.url.params["addr"])
            return httpx.Response(200, json=hit) if hit else httpx.Response(404, text="no match for IP:port")
        if path == "/localapi/v0/serve-config":
            return httpx.Response(200, json=SERVE_CONFIG)
        return httpx.Response(404)
    return httpx.MockTransport(handler), seen


def test_status_parsing():
    st = asyncio.run(Tailnet(transport=localapi()[0]).status())
    assert st == {"installed": True, "running": True, "backendState": "Running", "online": True,
                  "loggedIn": True, "ip": "100.101.102.103", "dnsName": "surface.tail1234.ts.net",
                  "stableId": "nAbC123CNTRL", "hostName": "surface", "loginName": "doug@example.com"}
    logged_out = parse_status({"BackendState": "NeedsLogin", "Self": {}})
    assert not logged_out["online"] and not logged_out["loggedIn"] and logged_out["ip"] is None
    assert parse_status({"BackendState": "Stopped", "Self": {}})["loggedIn"]


def test_not_installed_and_not_running(tmp_path):
    t = Tailnet(str(tmp_path / "nope.sock"), cli=str(tmp_path / "no-tailscale"))
    assert asyncio.run(t.status()) == {"installed": False}

    def refused(req):
        raise httpx.ConnectError("connection refused")
    st = asyncio.run(Tailnet(transport=httpx.MockTransport(refused)).status())
    assert st == {"installed": True, "running": False, "online": False, "loggedIn": False}


def test_whois():
    transport, seen = localapi(whois={"100.64.0.7:51234": {
        "Node": {"StableID": "nXyZCNTRL", "Name": "laptop.tail1234.ts.net."},
        "UserProfile": {"LoginName": "doug@example.com"}}})
    t = Tailnet(transport=transport)
    assert asyncio.run(t.whois("100.64.0.7:51234")) == {
        "stableId": "nXyZCNTRL", "nodeName": "laptop.tail1234.ts.net", "loginName": "doug@example.com"}
    assert "addr=100.64.0.7%3A51234" in seen[-1]
    assert asyncio.run(t.whois("100.64.0.9:1")) is None


def test_served_ports_are_only_wadds_own():
    assert served_ports(SERVE_CONFIG) == {3100}
    assert served_ports({}) == set()


# ------------------------------------------------------------------- the CLI
FAKE_CLI = """#!/bin/bash
# A stand-in for the tailscale CLI: logs its argv, and for `up` what the key file held.
printf '%s\\n' "$*" >> "{log}"
case "$1" in
  login) echo; echo "To authenticate, visit:"; echo; printf '\\thttps://login.tailscale.com/a/1a2b3c4d\\n'; exec sleep 30 ;;
  up) for a in "$@"; do case "$a" in --auth-key=file:*)
        f="${{a#--auth-key=file:}}"; cat "$f" > "{dir}/key-seen"; stat -c %a "$f" > "{dir}/key-mode" ;; esac; done ;;
  serve) [ "$2" = "--bg" ] || [ "$3" = "off" ] || exit 1 ;;
  fail) echo "boom" >&2; exit 1 ;;
esac
"""


@pytest.fixture
def cli(tmp_path):
    script = tmp_path / "tailscale"
    script.write_text(FAKE_CLI.format(log=tmp_path / "argv.log", dir=tmp_path))
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    state = tmp_path / "state"
    t = Tailnet(cli=str(script), state_dir=state,
                transport=localapi({"BackendState": "NeedsLogin", "Self": {}})[0])
    return t, tmp_path


def argv(tmp_path):
    return (tmp_path / "argv.log").read_text().splitlines()


def test_login_returns_the_url_without_waiting_for_it(cli):
    t, tmp = cli

    async def go():
        out = await asyncio.wait_for(t.login(), 10)  # the CLI itself sleeps 30 s
        running = t._login is not None and not t._login.done()
        await t.close()
        return out, running
    out, running = asyncio.run(go())
    assert out == {"url": "https://login.tailscale.com/a/1a2b3c4d", "online": False}
    assert running  # still waiting for the browser
    assert argv(tmp) == ["login --timeout=10m"]


def test_login_when_already_online(cli):
    t, tmp = cli
    t._transport = localapi()[0]
    assert asyncio.run(t.login()) == {"url": None, "online": True}
    assert not (tmp / "argv.log").exists()


def test_the_auth_key_never_goes_on_argv(cli):
    t, tmp = cli
    key = "tskey-auth-kSECRET123-abcdef"
    asyncio.run(t.up_with_authkey(key + "\n"))
    line, = argv(tmp)
    assert key not in line and line.startswith(f"up --auth-key=file:{tmp / 'state'}/")
    assert (tmp / "key-seen").read_text() == key and (tmp / "key-mode").read_text().strip() == "600"
    assert os.listdir(tmp / "state") == []  # the key file is gone again


def test_serve_and_unserve_commands(cli):
    t, tmp = cli

    async def go():
        await t.serve(3100)
        await t.unserve(3100)
        await t.logout()
    asyncio.run(go())
    assert argv(tmp) == ["serve --bg --https=3100 http://127.0.0.1:3100", "serve --https=3100 off", "logout"]
    assert not any("funnel" in a for a in argv(tmp))


def test_cli_errors_carry_the_output(cli):
    t, _ = cli
    with pytest.raises(Exception, match="boom"):
        asyncio.run(t._run("fail"))


# ---------------------------------------------------------- stream serving
class FakeClient:
    installed = True

    def __init__(self):
        self.st = parse_status(STATUS)
        self.serving = {9999}  # served by hand: not wadd's
        self.calls = []

    async def status(self):
        return dict(self.st)

    async def served_ports(self):
        return set(self.serving)

    async def serve(self, port):
        self.calls.append(("serve", port))
        self.serving.add(port)

    async def unserve(self, port):
        self.calls.append(("unserve", port))
        self.serving.discard(port)

    async def close(self):
        pass


@pytest.fixture
def watched(tmp_path, monkeypatch):
    from wadd import manager as manager_mod

    async def instant(url, timeout, interval=1.0):
        return None
    monkeypatch.setattr(manager_mod, "wait_http_ok", instant)
    cfg = parse_config({"daemon": {"state_dir": str(tmp_path)}, "workspaces": [
        {"id": "a", "name": "A", "image": "i", "port": 3100},
        {"id": "b", "name": "B", "image": "i", "port": 3101},
        {"id": "n", "name": "N", "image": "i", "display": "host"},
    ]})
    mgr = WorkspaceManager(cfg, FakeBackend(), NullKiosk())
    events = []
    mgr.bus.publish = events.append
    client = FakeClient()
    mgr.tailnet = TailnetWatch(mgr, client)
    return mgr, client, events


def test_running_streams_are_served_and_stopped_ones_unserved(watched):
    mgr, client, events = watched

    async def go():
        w = mgr.tailnet
        await w.poll()
        await w.reconcile()
        assert client.calls == [] and w.streams() == []
        await mgr.start("a")
        await mgr.start("n")
        await asyncio.gather(*mgr.tasks.values())
        assert w._kick.is_set()  # a container started: look again now
        await w.reconcile()
        assert client.calls == [("serve", 3100)]  # not the native one, not the hand-made 9999
        assert w.streams() == [{"wsId": "a", "url": "https://surface.tail1234.ts.net:3100/"}]
        w._kick.clear()
        await mgr.stop("a")
        assert w._kick.is_set()
        await w.reconcile()
        assert client.calls[-1] == ("unserve", 3100) and client.serving == {9999}
        assert w.streams() == []
    asyncio.run(go())
    assert any(e["type"] == "tailnet" and e["data"]["online"] for e in events)


def test_nothing_is_served_offline_or_when_turned_off(watched):
    mgr, client, _ = watched

    async def go():
        w = mgr.tailnet
        mgr.backend.running.add("a")
        mgr.states["a"].container = "running"
        client.st = {**client.st, "online": False, "backendState": "Stopped"}
        await w.poll()
        await w.reconcile()
        assert client.calls == [] and w.streams() == []
        client.st = parse_status(STATUS)  # back online: served on that round
        await w.poll()
        await w.reconcile()
        assert client.calls == [("serve", 3100)]
        mgr.cfg.daemon.tailnet_streams = False
        await w.reconcile()
        assert client.calls[-1] == ("unserve", 3100)
    asyncio.run(go())


def test_api_tailnet(watched, tmp_path):
    from fastapi.testclient import TestClient
    from wadd.api import create_app
    mgr, client, _ = watched
    mgr.backend.running.add("a")
    mgr.states["a"].container = "running"
    logins = []

    async def login():
        logins.append(1)
        return {"url": "https://login.tailscale.com/a/x", "online": False}
    client.login = login
    with TestClient(create_app(mgr)) as c:
        st = c.get("/api/tailnet").json()
        assert st["online"] and st["dnsName"] == "surface.tail1234.ts.net" and st["streams"] == []
        assert c.post("/api/tailnet/login").json() == {"url": "https://login.tailscale.com/a/x", "online": False}
        assert c.post("/api/tailnet/login", headers={"Origin": "https://evil.example"}).status_code == 403
        assert len(logins) == 1
    mgr.tailnet = None
    with TestClient(create_app(mgr)) as c:
        assert c.get("/api/tailnet").json() == {"installed": False, "streams": []}
        assert c.post("/api/tailnet/login").status_code == 404
