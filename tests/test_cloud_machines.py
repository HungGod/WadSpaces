"""The relay's machine side: the heartbeat's tailnet, streams and mounted
projects, the sibling machines, and tailscale_authkey in sync_secrets."""
import asyncio
import time

import httpx
import yaml

from wadd import backends
from wadd.cloud import CloudRelay
from wadd.config import CloudConfig, load_config, parse_config, save_config
from wadd.tailnet import TailnetWatch, parse_status
from test_cloud_projects import FakeFirestore, relay, ts  # noqa: F401 - relay is a fixture
from test_launches import env, wait_for  # noqa: F401 - env is a fixture
from test_tailnet import STATUS, FakeClient


def test_heartbeat_publishes_tailnet_streams_and_mounted_projects(relay):  # noqa: F811
    r, mgr, fs, _ = relay
    mgr.tailnet = TailnetWatch(mgr, FakeClient())
    mgr.tailnet.status = parse_status(STATUS)
    mgr.tailnet.served = {3100}
    mgr.cfg.workspaces[0].projects = [{"id": "p2", "mount": "B"}, {"id": "p1", "mount": "A"}]
    mgr.states["a"].container = "running"
    asyncio.run(r.heartbeat())
    doc = fs.get("users/u1/machines/m1")
    assert doc["tailnet"] == {"online": True, "ip": "100.101.102.103", "dnsName": "surface.tail1234.ts.net",
                              "stableId": "nAbC123CNTRL"}
    assert doc["streams"] == [{"wsId": "a", "url": "https://surface.tail1234.ts.net:3100/"}]
    assert doc["mountedProjects"] == ["p1", "p2"]
    path, mask = fs.patches[-1]
    assert "syncthing" not in mask and {"tailnet", "streams", "mountedProjects"} <= set(mask)


def test_heartbeat_without_tailscale(relay):  # noqa: F811
    r, mgr, fs, _ = relay
    mgr.tailnet = TailnetWatch(mgr, FakeClient())  # status: not installed (until polled)
    asyncio.run(r.heartbeat())
    doc = fs.get("users/u1/machines/m1")
    assert "tailnet" not in doc and doc["streams"] == [] and doc["mountedProjects"] == []
    mgr.tailnet = None
    asyncio.run(r.heartbeat())
    assert "tailnet" not in fs.patches[-1][1]


def test_siblings(relay):  # noqa: F811
    r, mgr, fs, _ = relay
    fresh = ts(int(time.time() * 1000) - 20_000)
    stale = ts(int(time.time() * 1000) - 600_000)
    fs.put("users/u1/machines/m1", {"name": "This one", "lastSeen": fresh, "mountedProjects": ["p1"]})
    fs.put("users/u1/machines/m2", {"name": "Surface", "lastSeen": fresh, "mountedProjects": ["p1"],
                                    "tailnet": {"ip": "100.64.0.2", "dnsName": "surface.ts.net",
                                                "stableId": "nS", "online": True}})
    fs.put("users/u1/machines/m3", {"hostname": "old-laptop", "lastSeen": stale, "mountedProjects": ["p1"]})
    sibs = asyncio.run(r.load_siblings())  # the fake pages one document at a time
    assert [s["id"] for s in sibs] == ["m2", "m3"]
    assert sibs[0] == {"id": "m2", "name": "Surface", "online": True, "ip": "100.64.0.2",
                       "dnsName": "surface.ts.net", "stableId": "nS", "mountedProjects": ["p1"]}
    assert sibs[1]["name"] == "old-laptop" and not sibs[1]["online"]
    assert r.open_elsewhere("p1") == ["Surface"] and r.open_elsewhere("p9") == []


class FakePodmanApi:
    created = []

    def __init__(self, socket):
        pass

    async def create_secret(self, name, value, replace=False):
        self.created.append((name, value))

    async def close(self):
        pass


def test_tailscale_authkey_joins_the_tailnet_instead_of_podman(relay, monkeypatch):  # noqa: F811
    r, mgr, fs, _ = relay
    monkeypatch.setattr(backends.podman, "PodmanApi", FakePodmanApi)
    FakePodmanApi.created = []
    fs.put("users/u1/secrets/github_token", {"value": "ghp_x"})
    fs.put("users/u1/secrets/tailscale_authkey", {"value": "tskey-auth-k1"})
    client = FakeClient()
    client.st = parse_status({"BackendState": "NeedsLogin", "Self": {}})
    keys = []

    async def up_with_authkey(key):
        keys.append(key)
        client.st = parse_status(STATUS)
    client.up_with_authkey = up_with_authkey
    mgr.tailnet = TailnetWatch(mgr, client)
    out = asyncio.run(r.sync_secrets())
    assert out == {"ok": True, "tailnet": "joined", "secrets": ["github_token"]}
    assert keys == ["tskey-auth-k1"] and FakePodmanApi.created == [("github_token", b"ghp_x")]
    assert mgr.tailnet._kick.is_set()
    # Already on the tailnet: left alone.
    assert asyncio.run(r.sync_secrets())["tailnet"] == "already" and len(keys) == 1
    # No Tailscale here: nothing to join, still not a podman secret.
    mgr.tailnet = None
    assert asyncio.run(r.sync_secrets())["tailnet"] == "unavailable"
    assert [n for n, _ in FakePodmanApi.created] == ["github_token"] * 3


def test_a_launch_warns_when_a_project_is_open_on_another_machine(env):  # noqa: F811
    c, mgr, git, _, tmp = env
    fs = FakeFirestore()
    r = CloudRelay(CloudConfig(project_id="p", firestore_base="http://fs", state_file=str(tmp / "enr.json")), mgr)
    r.state = {"owner_uid": "u1", "machine_id": "m1", "refresh_token": "x"}
    r.id_token, r.id_token_exp = "T", time.time() + 3600
    r.http = httpx.AsyncClient(transport=httpx.MockTransport(fs.handler))
    fs.put("users/u1/machines/m2", {"name": "Surface", "lastSeen": ts(int(time.time() * 1000)),
                                    "mountedProjects": ["notes"]})
    job = wait_for(c, c.post("/api/launches", json={"workspace": "a", "projects": ["notes", "vault"]}).json()["id"])
    assert job["status"] == "done", job
    warnings = [line for line in job["lines"] if line.startswith("⚠")]
    assert warnings == ["⚠ Notes is open on Surface: stop it there first to avoid conflicts"]
    # The cloud unreachable, or not enrolled: no warning, the launch goes on.
    async def unreachable():
        raise httpx.ConnectError("offline")
    r.load_siblings = unreachable
    job = wait_for(c, c.post("/api/launches", json={"workspace": "b", "projects": ["notes"]}).json()["id"])
    assert job["status"] == "done" and not any(line.startswith("⚠") for line in job["lines"])
    r.state = {}
    job = wait_for(c, c.post("/api/launches", json={"workspace": "b", "projects": ["notes"]}).json()["id"])
    assert job["status"] == "done" and not any(line.startswith("⚠") for line in job["lines"])


def test_new_tailnet_keys_stay_out_of_the_file(tmp_path):
    p = tmp_path / "w.yaml"
    cfg = parse_config({"workspaces": [{"id": "a", "name": "A", "image": "i", "port": 3100}]}, p)
    save_config(cfg)
    daemon = yaml.safe_load(p.read_text())["daemon"]
    assert not {"tailscale_socket", "tailscale_bin", "tailnet_streams"} & set(daemon)
    cfg.daemon.tailnet_streams = False
    save_config(cfg)
    assert yaml.safe_load(p.read_text())["daemon"]["tailnet_streams"] is False
    assert load_config(p, vendor_cloud=None).daemon.tailnet_streams is False
