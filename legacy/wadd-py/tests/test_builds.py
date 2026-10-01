"""Builds on the machine: /api/builds with a fake podman."""
import asyncio
import time

import pytest
import yaml
from fastapi.testclient import TestClient

from wadd.api import create_app
from wadd.backends.podman import PodmanError
from wadd.config import parse_config
from wadd.kiosk import NullKiosk
from wadd.manager import WorkspaceManager
from test_manager import FakeBackend


class FakePodman:
    def __init__(self):
        self.images = {"localhost/wadspaces-base:trixie"}
        self.built = []
        self.pulled = []
        self.fail = None
        self.slow = False

    async def image_exists(self, ref):
        return ref in self.images

    async def pull(self, ref, progress=None):
        self.pulled.append(ref)
        if progress:
            progress(None, f"Copying blob sha256:{'a' * 12}")
        self.images.add(ref)

    async def build(self, context, tag, buildargs=None, on_line=None):
        on_line("STEP 1/2: FROM ${BASE_IMAGE}")
        if self.slow:
            await asyncio.sleep(30)
        on_line("STEP 2/2: COPY root/ /")
        if self.fail:
            raise PodmanError(self.fail)
        self.built.append((tag, buildargs, len(context)))
        self.images.add(tag)
        return "f" * 64


class Backend(FakeBackend):
    def __init__(self):
        super().__init__()
        self.api = FakePodman()


SPEC = {"id": "notes-abc123", "name": "Notes", "image": "whatever", "display": "host",
        "env": {"TZ": "Pacific/Fiji"}, "devices": ["/dev/dri"]}


@pytest.fixture
def env(tmp_path):
    cfg = parse_config({"daemon": {"state_dir": str(tmp_path), "build_min_free_gb": 0},
                        "workspaces": [{"id": "a", "name": "A", "image": "i", "port": 3100}]},
                       tmp_path / "w.yaml")
    mgr = WorkspaceManager(cfg, Backend(), NullKiosk())
    with TestClient(create_app(mgr)) as c:
        yield c, mgr, tmp_path


def wait_for(c, job_id, statuses=("done", "error", "cancelled"), timeout=5):
    end = time.time() + timeout
    while time.time() < end:
        job = c.get(f"/api/builds/{job_id}").json()
        if job["status"] in statuses:
            return job
        time.sleep(0.05)
    raise AssertionError(f"build stuck: {job}")


def test_build_installs_a_new_workspace(env):
    c, mgr, tmp = env
    job = c.post("/api/builds", json={"workspace": SPEC}).json()
    assert job["status"] == "waiting"
    r = c.put(f"/api/builds/{job['id']}/context", content=b"x" * 2048, headers={"Content-Type": "application/x-tar"})
    assert r.status_code == 202
    done = wait_for(c, job["id"])
    assert done["status"] == "done", done
    assert done["progress"] == 1.0 and done["image"] == "localhost/wadspaces-notes-abc123:latest"
    assert "STEP 2/2: COPY root/ /" in done["lines"]
    tag, args, size = mgr.podman.built[0]
    assert tag == "localhost/wadspaces-notes-abc123:latest" and args == {"BASE_IMAGE": "localhost/wadspaces-base:trixie"} and size == 2048
    # It's a workspace on the machine now, saved to workspaces.yaml, running the built image.
    ws = mgr.cfg.workspace("notes-abc123")
    assert ws.image == "localhost/wadspaces-notes-abc123:latest" and ws.native
    saved = yaml.safe_load((tmp / "w.yaml").read_text())
    assert any(w["id"] == "notes-abc123" for w in saved["workspaces"])
    assert (tmp / "builds" / f"{job['id']}.log").read_text().startswith("» building")


def test_rebuild_updates_the_existing_workspace(env):
    c, mgr, _ = env
    for _ in range(2):
        job = c.post("/api/builds", json={"workspace": {**SPEC, "name": "Notes v2"}}).json()
        c.put(f"/api/builds/{job['id']}/context", content=b"tar")
        done = wait_for(c, job["id"])
    assert done["installed"] is True
    assert mgr.cfg.workspace("notes-abc123").name == "Notes v2"
    assert len([w for w in mgr.cfg.workspaces if w.id == "notes-abc123"]) == 1


def test_a_base_on_the_machine_is_built_on(env):
    c, mgr, _ = env
    mgr.podman.images = {"localhost/wadspaces-stream:trixie"}
    job = c.post("/api/builds", json={"workspace": SPEC, "base_image": "localhost/wadspaces-stream:trixie"}).json()
    c.put(f"/api/builds/{job['id']}/context", content=b"tar")
    assert wait_for(c, job["id"])["status"] == "done"
    assert mgr.podman.built[0][1] == {"BASE_IMAGE": "localhost/wadspaces-stream:trixie"}
    assert mgr.podman.pulled == []


def test_a_missing_base_fails_the_build_and_says_how_to_get_it(env):
    # Bases come on the update drive, never from a registry (an old
    # ghcr.io/hunggod base doesn't stand in for one either).
    c, mgr, _ = env
    mgr.podman.images = {"ghcr.io/hunggod/wadspaces-base:trixie"}
    job = c.post("/api/builds", json={"workspace": SPEC}).json()
    c.put(f"/api/builds/{job['id']}/context", content=b"tar")
    done = wait_for(c, job["id"])
    assert done["status"] == "error"
    assert done["error"] == ("base image localhost/wadspaces-base:trixie is not on this machine"
                             " — update the drive with host/build.sh update --bases")
    assert mgr.podman.pulled == [] and mgr.podman.built == []
    assert not any(w.id == "notes-abc123" for w in mgr.cfg.workspaces)


def test_a_failed_build_says_why_and_installs_nothing(env):
    c, mgr, _ = env
    mgr.podman.fail = 'building at STEP "COPY": no such file'
    job = c.post("/api/builds", json={"workspace": SPEC}).json()
    c.put(f"/api/builds/{job['id']}/context", content=b"tar")
    done = wait_for(c, job["id"])
    assert done["status"] == "error" and "no such file" in done["error"]
    assert not any(w.id == "notes-abc123" for w in mgr.cfg.workspaces)


def test_bad_specs_are_refused_before_building(env):
    c, _, _ = env
    assert c.post("/api/builds", json={"workspace": {**SPEC, "id": "Bad ID"}}).status_code == 422
    assert c.post("/api/builds", json={"workspace": {**SPEC, "hotkey": 42}}).status_code == 422
    assert c.post("/api/builds", json={"workspace": {**SPEC, "port": 8080, "display": "stream"}}).status_code == 422


def test_one_build_per_workspace_and_no_empty_context(env):
    c, _, _ = env
    job = c.post("/api/builds", json={"workspace": SPEC}).json()
    assert c.post("/api/builds", json={"workspace": SPEC}).status_code == 409
    assert c.put(f"/api/builds/{job['id']}/context", content=b"").status_code == 409
    assert c.put("/api/builds/nope/context", content=b"x").status_code == 404


def test_cancel_stops_a_running_build(env):
    c, mgr, _ = env
    mgr.podman.slow = True
    job = c.post("/api/builds", json={"workspace": SPEC}).json()
    c.put(f"/api/builds/{job['id']}/context", content=b"tar")
    wait_for(c, job["id"], statuses=("building",))
    assert c.delete(f"/api/builds/{job['id']}").json()["status"] == "cancelled"
    done = wait_for(c, job["id"])
    assert done["status"] == "cancelled" and not mgr.podman.built
    assert not any(w.id == "notes-abc123" for w in mgr.cfg.workspaces)


def test_not_enough_disk(env):
    c, mgr, _ = env
    mgr.cfg.daemon.build_min_free_gb = 10**9
    job = c.post("/api/builds", json={"workspace": SPEC}).json()
    c.put(f"/api/builds/{job['id']}/context", content=b"tar")
    done = wait_for(c, job["id"])
    assert done["status"] == "error" and "free" in done["error"]


def test_untrusted_origins_cant_build(env):
    c, _, _ = env
    r = c.post("/api/builds", json={"workspace": SPEC}, headers={"Origin": "https://evil.example"})
    assert r.status_code == 403
    assert c.post("/api/builds", json={"workspace": SPEC}, headers={"Origin": "app://wadcreator"}).status_code == 201
