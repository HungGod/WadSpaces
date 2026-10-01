"""Wad Creator's library on the machine, run history, and machine metrics."""
import os

import pytest
from fastapi.testclient import TestClient

from wadd import metrics
from wadd.api import create_app
from wadd.config import parse_config
from wadd.kiosk import NullKiosk
from wadd.library import Library, LibraryError
from wadd.manager import WorkspaceManager
from wadd.runs import RunLog
from test_manager import FakeBackend


@pytest.fixture
def client(tmp_path):
    cfg = parse_config({"daemon": {"state_dir": str(tmp_path)},
                        "workspaces": [{"id": "a", "name": "A", "image": "i", "port": 3100}]}, tmp_path / "w.yaml")
    mgr = WorkspaceManager(cfg, FakeBackend(), NullKiosk())
    with TestClient(create_app(mgr)) as c:
        yield c, mgr


def test_library_round_trip(tmp_path):
    lib = Library(tmp_path)
    lib.put("wadspaces", "deep-work-abc123", {"spec": {"name": "Deep work"}})
    assert lib.get("wadspaces", "deep-work-abc123")["spec"]["name"] == "Deep work"
    assert [d["spec"]["name"] for d in lib.list("wadspaces")] == ["Deep work"]
    assert lib.list("drafts") == []
    assert lib.delete("wadspaces", "deep-work-abc123") and not lib.delete("wadspaces", "deep-work-abc123")
    with pytest.raises(KeyError):
        lib.get("wadspaces", "deep-work-abc123")


def test_library_refuses_bad_names(tmp_path):
    lib = Library(tmp_path)
    for coll, doc_id in [("etc", "x"), ("wadspaces", "../escape"), ("wadspaces", "")]:
        with pytest.raises(LibraryError):
            lib.put(coll, doc_id, {})
    with pytest.raises(LibraryError):
        lib.put("wadspaces", "ok", ["not", "an", "object"])


def test_library_api(client):
    c, _ = client
    assert c.put("/api/library/drafts/d1", json={"name": "Draft"}).status_code == 200
    assert c.get("/api/library/drafts").json() == [{"name": "Draft"}]
    assert c.get("/api/library/drafts/d1").json()["name"] == "Draft"
    assert c.get("/api/library/nope").status_code == 404
    assert c.put("/api/library/drafts/d1", json={"x": 1}, headers={"Origin": "https://evil.example"}).status_code == 403
    assert c.delete("/api/library/drafts/d1").status_code == 200
    assert c.get("/api/library/drafts/d1").status_code == 404


def test_runs_open_and_close(tmp_path):
    runs = RunLog(tmp_path / "runs.jsonl")
    runs.start("a", "A", "local")
    runs.end("a")
    runs.start("b", "B", "stream")
    got = runs.list()
    assert [r["wadspaceId"] for r in got] == ["b", "a"]
    assert got[0]["endedAt"] is None and got[1]["endedAt"] >= got[1]["startedAt"]
    assert [r["wadspaceId"] for r in runs.list("a")] == ["a"]


def test_a_run_left_open_by_a_restart_is_closed(tmp_path):
    RunLog(tmp_path / "runs.jsonl").start("a", "A", "local")
    after_restart = RunLog(tmp_path / "runs.jsonl")
    assert after_restart.list()[0]["endedAt"] is not None


def test_container_changes_become_runs(client):
    c, mgr = client
    mgr._set("a", container="running")
    mgr._set("a", container="unknown")  # podman didn't answer: still running as far as we know
    assert c.get("/api/runs").json()[0]["endedAt"] is None
    mgr._set("a", container="exited")
    runs = c.get("/api/runs?workspace=a").json()
    assert len(runs) == 1 and runs[0]["endedAt"] is not None and runs[0]["mode"] == "stream"


def test_metrics_from_proc(tmp_path):
    (tmp_path / "stat").write_text("cpu  100 0 100 800 0 0 0 0 0 0\n")
    (tmp_path / "meminfo").write_text("MemTotal: 1000 kB\nMemFree: 100 kB\nMemAvailable: 250 kB\n")
    metrics._last_cpu = (200, 1000)  # the first sample: 200 busy of 1000
    (tmp_path / "stat").write_text("cpu  200 0 200 1400 0 0 0 0 0 0\n")  # +200 busy of +800
    assert metrics.cpu_percent(tmp_path) == 25.0
    assert metrics.memory(tmp_path) == {"total": 1024000, "used": 768000, "percent": 75.0}


def test_gpu_name(tmp_path):
    dev = tmp_path / "card0" / "device"
    dev.mkdir(parents=True)
    (tmp_path / "drivers" / "i915").mkdir(parents=True)
    os.symlink(tmp_path / "drivers" / "i915", dev / "driver")
    (dev / "vendor").write_text("0x8086\n")
    assert metrics.gpu_name(tmp_path) == "Intel (i915)"
    assert metrics.gpu_name(tmp_path / "none") == ""


def test_metrics_api(client):
    c, _ = client
    m = c.get("/api/metrics").json()
    assert 0 <= m["cpu"] <= 100 and m["memTotal"] > 0 and m["diskTotal"] > 0
