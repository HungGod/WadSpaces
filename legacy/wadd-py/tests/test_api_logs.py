import logging

import pytest
from fastapi.testclient import TestClient

from wadd import logbuffer
from wadd.api import create_app
from wadd.config import parse_config
from wadd.kiosk import NullKiosk
from wadd.manager import WorkspaceManager
from test_manager import FakeBackend


@pytest.fixture
def client(tmp_path):
    cfg = parse_config({"workspaces": [{"id": "a", "name": "A", "image": "i", "port": 3100}]},
                       tmp_path / "w.yaml")
    mgr = WorkspaceManager(cfg, FakeBackend(), NullKiosk())
    logbuffer.install()
    return TestClient(create_app(mgr)), mgr


@pytest.mark.parametrize("raw, gone", [
    ("token ghp_" + "a" * 36 + " end", "ghp_"),
    ("pat github_pat_" + "B1_" * 20, "github_pat_"),
    ("Authorization: Bearer abcdefghijklmnop", "abcdefghijklmnop"),
    ('{"password": "hunter22"}', "hunter22"),
    ("https://x-access-token:s3cretvalue@github.com/o/r", "s3cretvalue"),
])
def test_redact(raw, gone):
    out = logbuffer.redact(raw)
    assert gone not in out and "[redacted]" in out


def test_daemon_log_is_redacted_and_clamped(client):
    c, _ = client
    log = logging.getLogger("wadd.test")
    log.warning("pull failed with ghp_%s", "z" * 36)
    lines = c.get("/api/logs/daemon", params={"lines": 5}).json()["lines"]
    assert lines and "ghp_" not in lines[-1]["message"] and lines[-1]["level"] == "WARNING"
    assert len(c.get("/api/logs/daemon", params={"lines": 99999}).json()["lines"]) <= 2000


def test_unit_logs_only_for_known_units(client):
    c, mgr = client
    r = c.get("/api/logs/unit/sshd")
    assert r.status_code == 404 and "wad-a" in r.json()["detail"]
    assert "wad-a" in mgr.log_units() and "wadd" in mgr.log_units()


def test_workspace_logs_unknown_workspace(client):
    c, _ = client
    assert c.get("/api/logs/workspace/nope").status_code == 404


def test_diagnostics_survives_a_missing_podman(client):
    c, _ = client
    logging.getLogger("wadd.test").error("could not start a")
    d = c.get("/api/diagnostics").json()
    assert d["wadd"]["version"] and d["disk"]["total_bytes"] > 0
    assert "error" in d["podman"]  # the fake backend has no API: reported, not raised
    assert [w["id"] for w in d["workspaces"]] == ["a"]
    assert d["recent_problems"][-1]["message"] == "could not start a"
