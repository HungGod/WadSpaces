"""Building workspace images on this machine (Wad Creator's Build, offline).

    POST /api/builds               {"workspace": <spec>, "base_image": "..."}  -> a job
    PUT  /api/builds/{id}/context  the build folder as a tar                    -> starts it
    GET  /api/builds[/{id}]        jobs; one job's log with ?since=<line>
    DELETE /api/builds/{id}        cancel

Wad Creator generates the build folder (Dockerfile, root/) in the browser and
sends it as a tar; podman builds it here as localhost/wadspaces-<id>:latest, and
the workspace is added to (or updated in) workspaces.yaml. One build runs at a
time. Progress goes out as `build` events on /api/events: the job, plus the log
lines since the last event.
"""
from __future__ import annotations

import asyncio
import logging
import re
import shutil
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from .config import ConfigError, config_to_dict, parse_config, workspace_to_dict

log = logging.getLogger(__name__)

MAX_CONTEXT_BYTES = 64 * 1024 * 1024
MAX_LINES = 4000
PUBLISH_EVERY_S = 0.25
STEP_RE = re.compile(r"^STEP (\d+)/(\d+):")
LOCAL_BASE_RE = re.compile(r"^localhost/wadspaces-([a-z0-9-]+):([\w.-]+)$")


class BuildError(Exception):
    pass


@dataclass
class BuildJob:
    id: str
    ws_id: str
    name: str
    spec: dict
    base_image: str
    status: str = "waiting"  # waiting | queued | building | done | error | cancelled
    progress: float = 0.0
    error: str | None = None
    image: str = ""
    created: float = field(default_factory=time.time)
    started: float | None = None
    finished: float | None = None
    installed: bool = False  # new workspace (False) or updated one (True)
    restart_required: bool = False
    lines: list[str] = field(default_factory=list)
    dropped: int = 0  # lines trimmed from the front (MAX_LINES)

    def summary(self) -> dict:
        return {
            "id": self.id, "wsId": self.ws_id, "name": self.name, "status": self.status,
            "progress": round(self.progress, 3), "error": self.error, "image": self.image,
            "created": self.created, "started": self.started, "finished": self.finished,
            "installed": self.installed, "restartRequired": self.restart_required,
            "lineCount": self.dropped + len(self.lines),
        }

    def lines_since(self, n: int) -> list[str]:
        return self.lines[max(0, n - self.dropped):]


class Builds:
    def __init__(self, manager) -> None:
        self.manager = manager
        self.jobs: dict[str, BuildJob] = {}
        self.tasks: dict[str, asyncio.Task] = {}
        self._one_at_a_time = asyncio.Lock()
        self._sent: dict[str, int] = {}  # lines already published, per job
        self._last_publish = 0.0

    # ------------------------------------------------------------------ jobs
    @property
    def log_dir(self) -> Path:
        return Path(self.manager.cfg.daemon.state_dir) / "builds"

    def create(self, spec: dict, base_image: str) -> BuildJob:
        """Check the workspace spec against the whole config before any work."""
        if not isinstance(spec, dict) or not spec.get("id"):
            raise ConfigError("workspace spec needs an id")
        ws_id = spec["id"]
        if any(j.ws_id == ws_id and j.status in ("waiting", "queued", "building") for j in self.jobs.values()):
            raise BuildError(f"{ws_id} is already building")
        if not LOCAL_BASE_RE.match(base_image or "") and "/" not in (base_image or ""):
            raise ConfigError(f"bad base image {base_image!r}")
        spec = {**spec, "image": f"localhost/wadspaces-{ws_id}:latest"}
        self._validate(spec)
        job = BuildJob(id=uuid.uuid4().hex[:12], ws_id=ws_id, name=spec.get("name", ws_id), spec=spec,
                       base_image=base_image)
        self.jobs[job.id] = job
        self._trim()
        self._publish(job, force=True)
        return job

    def _validate(self, spec: dict) -> None:
        cfg = self.manager.cfg
        others = [workspace_to_dict(w) for w in cfg.workspaces if w.id != spec["id"]]
        d = config_to_dict(cfg)
        d["workspaces"] = others + [spec]
        parse_config(d, None)  # raises ConfigError

    def _trim(self) -> None:
        """Keep the last 20 finished jobs."""
        done = [j for j in self.jobs.values() if j.status in ("done", "error", "cancelled")]
        for j in sorted(done, key=lambda j: j.created)[:-20]:
            self.jobs.pop(j.id, None)
            self._sent.pop(j.id, None)

    def start(self, job_id: str, context: bytes) -> BuildJob:
        job = self.get(job_id)
        if job.status != "waiting":
            raise BuildError(f"build {job_id} already has its context")
        if len(context) > MAX_CONTEXT_BYTES:
            raise BuildError("build folder too big (64 MB max)")
        if not context:
            raise BuildError("empty build folder")
        job.status = "queued"
        self._publish(job, force=True)
        self.tasks[job.id] = asyncio.create_task(self._run(job, context))
        return job

    def get(self, job_id: str) -> BuildJob:
        try:
            return self.jobs[job_id]
        except KeyError:
            raise KeyError(job_id) from None

    def cancel(self, job_id: str) -> BuildJob:
        job = self.get(job_id)
        task = self.tasks.get(job_id)
        if job.status in ("waiting", "queued", "building"):
            if task:
                task.cancel()  # closes podman's stream, which aborts the build
            job.status = "cancelled"
            job.finished = time.time()
            self._line(job, "✗ cancelled")
            self._publish(job, force=True)
        return job

    # --------------------------------------------------------------- running
    def _line(self, job: BuildJob, text: str) -> None:
        job.lines.append(text)
        if len(job.lines) > MAX_LINES:
            cut = len(job.lines) - MAX_LINES
            del job.lines[:cut]
            job.dropped += cut
        m = STEP_RE.match(text)
        if m:
            step, total = int(m.group(1)), int(m.group(2))
            job.progress = max(job.progress, (step - 1) / total * 0.95)
        try:
            with open(self.log_dir / f"{job.id}.log", "a") as f:
                f.write(text + "\n")
        except OSError:
            pass
        self._publish(job)

    def _publish(self, job: BuildJob, force: bool = False) -> None:
        now = time.monotonic()
        if not force and now - self._last_publish < PUBLISH_EVERY_S:
            return
        self._last_publish = now
        for j in self.jobs.values():
            sent = self._sent.get(j.id, 0)
            total = j.dropped + len(j.lines)
            if j is not job and sent == total:
                continue
            self._sent[j.id] = total
            self.manager.bus.publish({"type": "build", "data": {**j.summary(), "from": sent, "lines": j.lines_since(sent)}})

    async def _base(self, job: BuildJob) -> str:
        """The base image to build on. Bases aren't downloaded from a registry:
        they reach a machine on the update drive (host/build.sh update --bases)."""
        ref = job.base_image
        if await self.manager.podman.image_exists(ref):
            return ref
        hint = " — update the drive with host/build.sh update --bases" if LOCAL_BASE_RE.match(ref) else ""
        raise BuildError(f"base image {ref} is not on this machine{hint}")

    def _check_disk(self) -> None:
        need = self.manager.cfg.daemon.build_min_free_gb
        path = self.manager.image_store if Path(self.manager.image_store).exists() else "/"
        free = shutil.disk_usage(path).free / 1e9
        if free < need:
            raise BuildError(f"only {free:.1f} GB free; building needs at least {need} GB")

    async def _run(self, job: BuildJob, context: bytes) -> None:
        self.log_dir.mkdir(parents=True, exist_ok=True)
        try:
            async with self._one_at_a_time:
                job.status = "building"
                job.started = time.time()
                self._publish(job, force=True)
                self._check_disk()
                base = await self._base(job)
                tag = job.spec["image"]
                self._line(job, f"» building {tag} on {base}")
                api = self.manager.podman
                job.image = tag
                await api.build(context, tag, {"BASE_IMAGE": base}, lambda text: self._line(job, text))
                await self._install(job)
                job.progress = 1.0
                job.status = "done"
                self._line(job, f"✓ built {tag}")
        except asyncio.CancelledError:
            job.status = "cancelled"
            raise
        except Exception as e:  # podman, config, disk: all end the job with a message
            log.warning("build %s (%s) failed: %s", job.id, job.ws_id, e)
            job.status = "error"
            job.error = str(e)
            self._line(job, f"✗ {e}")
        finally:
            job.finished = time.time()
            self.tasks.pop(job.id, None)
            self._publish(job, force=True)

    async def _install(self, job: BuildJob) -> None:
        """Add the workspace to this machine, or point the existing one at the new image."""
        mgr = self.manager
        exists = any(w.id == job.ws_id for w in mgr.cfg.workspaces)
        if exists:
            res = await mgr.update_workspace(job.ws_id, job.spec)
            job.installed = True
            job.restart_required = bool(res.get("restart_required"))
            # The image changed under the same name: a running container still
            # has the old one until it's restarted.
            if mgr.states.get(job.ws_id) and mgr.states[job.ws_id].container == "running":
                job.restart_required = True
        else:
            await mgr.create_workspace(job.spec)
        # Its image is here now: refresh the "downloaded" flag.
        st = mgr.states.get(job.ws_id)
        if st is not None:
            mgr._set(job.ws_id, image_present=True)
