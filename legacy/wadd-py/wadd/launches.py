"""Launching a workspace with projects: the image, plus project folders on disk.

    POST   /api/launches       {"workspace", "projects": [ids], "view"?, "restart"?} -> a job
    GET    /api/launches[/{id}]  jobs; one job's log with ?since=<line>
    DELETE /api/launches/{id}  cancel

Step 1 does everything that may take a while at once (asyncio.gather):
  - the image: it must be here (a localhost/ image is built, never pulled; a
    registry image is pulled through the manager, with its progress), and,
    when projects are mounted, labelled io.wadspaces.projects=1. Older images
    clone their repos over ~/Desktop at every start and would wreck a mounted
    folder, so they are refused.
  - each project's folder (projects.py has the kinds):
    - a GitHub repo, at <projects_dir>/<id>; projects move between machines
      through git (your own commit, push and pull). Already here: fetched,
      and fast-forwarded when that is safe (clean, an upstream, nothing
      unpushed; gitimport.update), else left as it is with the reason in the
      log; not being able to fetch is a warning. Not here: the copy an older
      image cloned into the workspace's /config volume (Desktop/<mount>, maybe
      with uncommitted work) moved over, else a fresh git clone (a failed
      clone fails the launch).
    - a folder: it must be this machine's, and there. Never touched (no
      fetch, even with a .git in it).
    - a drive: plugged in here; mounted if it isn't yet (drives.py), and the
      folder on it must be there. Never touched either.
    A project open in a running workspace on another of the owner's machines
    gets a warning in the log (the machines publish what they mount), not a
    refusal.
Step 2 writes <state_dir>/extra/<ws>/projects.json, points the workspace at the
projects ([{id, mount, path?}], path for a folder or drive; workspaces.yaml,
quadlet, daemon-reload; see quadlet.py), and brings
it up as a switch does. A container running with other projects has to be
stopped for that: the caller says so with restart (the UI asks first).

One launch per workspace at a time; different workspaces launch in parallel.
Progress goes out as `launch` events on /api/events: the job, plus the log
lines since the last event, like builds.
"""
from __future__ import annotations

import asyncio
import logging
import os
import shutil
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from . import gitimport
from .drives import DriveError, OutsideRoots, resolve_folder
from .projects import is_github_source, make_owned_dir, project_dir, relabel, write_manifest
from .state import ERROR

log = logging.getLogger(__name__)

MAX_LINES = 2000
PUBLISH_EVERY_S = 0.25
PROJECTS_LABEL = "io.wadspaces.projects"
VIEWS = ("screen", "stream")
STEP1_SHARE = 0.9  # of the progress bar; starting the workspace is the rest
OLD_BASE = "this image was built on an older base; rebuild it to use projects"
NOT_HERE = "not a GitHub repo and not on this machine"


class LaunchError(Exception):
    pass


def config_volume(volumes: list[str]) -> str | None:
    """The named volume a workspace keeps /config in (wad-<id>-config), if any."""
    for v in volumes:
        parts = v.split(":")
        if len(parts) >= 2 and parts[1].rstrip("/") == "/config" and "/" not in parts[0]:
            return parts[0]
    return None


def _project_set(projects: list[dict], paths: bool = True) -> set[tuple]:
    return {(p["id"], p["mount"], p.get("path") if paths else None) for p in projects}


@dataclass
class LaunchJob:
    id: str
    ws_id: str
    name: str
    projects: list[str]
    view: str
    restart: bool = False
    status: str = "queued"  # queued | running | done | error | cancelled
    progress: float = 0.0
    phase: str = "waiting to start"
    error: str | None = None
    created: float = field(default_factory=time.time)
    started: float | None = None
    finished: float | None = None
    # what step 1 is getting: {"key": "image" | <project id>, "kind", "name",
    # "state": waiting | working | done | error, "progress": 0..1 | None, "message"}
    parts: list[dict] = field(default_factory=list)
    lines: list[str] = field(default_factory=list)
    dropped: int = 0

    def summary(self) -> dict:
        return {
            "id": self.id, "wsId": self.ws_id, "name": self.name, "projects": self.projects,
            "view": self.view, "restart": self.restart, "status": self.status,
            "progress": round(self.progress, 3), "phase": self.phase, "error": self.error,
            "parts": [dict(p) for p in self.parts], "created": self.created, "started": self.started,
            "finished": self.finished, "lineCount": self.dropped + len(self.lines),
        }

    def lines_since(self, n: int) -> list[str]:
        return self.lines[max(0, n - self.dropped):]

    def part(self, key: str) -> dict:
        return next(p for p in self.parts if p["key"] == key)


class Launches:
    def __init__(self, manager) -> None:
        self.manager = manager
        self.jobs: dict[str, LaunchJob] = {}
        self.tasks: dict[str, asyncio.Task] = {}
        self._sent: dict[str, int] = {}
        self._last_publish = 0.0
        self._stopping: dict[str, asyncio.Lock] = {}

    @property
    def log_dir(self) -> Path:
        return Path(self.manager.cfg.daemon.state_dir) / "launches"

    # ------------------------------------------------------------------ jobs
    def create(self, ws_id: str, project_ids: list[str], view: str | None = None,
               restart: bool = False) -> LaunchJob:
        """Check everything that can be checked up front, then start.
        KeyError: no such workspace; ValueError: a bad request;
        LaunchError: not possible right now."""
        mgr = self.manager
        ws = mgr._ws(ws_id)
        if any(j.ws_id == ws.id and j.status in ("queued", "running") for j in self.jobs.values()):
            raise LaunchError(f"{ws.name} is already launching")
        own = "screen" if ws.native else "stream"
        view = view or own
        if view not in VIEWS:
            raise ValueError(f"view must be one of {VIEWS}")
        if view != own:
            raise LaunchError(f"{ws.name} is shown as a {own} on this machine; "
                              f"showing it as a {view} isn't possible yet")
        ids = list(dict.fromkeys(project_ids or []))
        wanted = []
        for pid in ids:
            doc = mgr.projects.get_or_none(pid) if isinstance(pid, str) else None
            if doc is None or doc.get("deleted"):
                raise ValueError(f"no project {pid!r}")
            wanted.append({"id": pid, "mount": doc["mountName"]})
        if len({p["mount"] for p in wanted}) != len(wanted):
            raise ValueError("two of these projects use the same folder name")
        if wanted and mgr.backend.name != "systemd":
            raise LaunchError("projects are mounted through the workspace's systemd unit; "
                              "this wadd runs the podman (dev) backend")
        if self._needs_restart(ws, wanted) and not restart:
            raise LaunchError(f"{ws.name} is running with other projects; pass restart to restart it")
        job = LaunchJob(id=uuid.uuid4().hex[:12], ws_id=ws.id, name=ws.name, projects=ids, view=view,
                        restart=restart)
        job.parts.append({"key": "image", "kind": "image", "name": ws.image, "state": "waiting",
                          "progress": None, "message": None})
        for pid in ids:
            job.parts.append({"key": pid, "kind": "project", "name": mgr.projects.get(pid)["name"],
                              "state": "waiting", "progress": None, "message": None})
        self.jobs[job.id] = job
        self._trim()
        self._publish(job, force=True)
        self.tasks[job.id] = asyncio.create_task(self._run(job))
        return job

    def _needs_restart(self, ws, wanted: list[dict]) -> bool:
        # A drive's mountpoint is only known once it's mounted: _start checks
        # the paths again.
        running = self.manager.states[ws.id].container == "running"
        return running and _project_set(ws.projects, paths=False) != _project_set(wanted, paths=False)

    def _trim(self) -> None:
        """Keep the last 20 finished jobs."""
        done = [j for j in self.jobs.values() if j.status in ("done", "error", "cancelled")]
        for j in sorted(done, key=lambda j: j.created)[:-20]:
            self.jobs.pop(j.id, None)
            self._sent.pop(j.id, None)

    def get(self, job_id: str) -> LaunchJob:
        try:
            return self.jobs[job_id]
        except KeyError:
            raise KeyError(job_id) from None

    def cancel(self, job_id: str) -> LaunchJob:
        job = self.get(job_id)
        if job.status in ("queued", "running"):
            task = self.tasks.get(job_id)
            if task:
                task.cancel()  # kills a clone in progress, which removes its .part
            job.status = "cancelled"
            job.finished = time.time()
            self._line(job, "✗ cancelled")
            self._publish(job, force=True)
        return job

    # --------------------------------------------------------------- output
    def _line(self, job: LaunchJob, text: str) -> None:
        job.lines.append(text)
        if len(job.lines) > MAX_LINES:
            cut = len(job.lines) - MAX_LINES
            del job.lines[:cut]
            job.dropped += cut
        try:
            with open(self.log_dir / f"{job.id}.log", "a") as f:
                f.write(text + "\n")
        except OSError:
            pass
        self._publish(job)

    def _part(self, job: LaunchJob, key: str, **changes) -> None:
        job.part(key).update(changes)
        parts = [p["progress"] if p["progress"] is not None else (1.0 if p["state"] == "done" else 0.0)
                 for p in job.parts]
        job.progress = max(job.progress, STEP1_SHARE * sum(parts) / len(parts))
        self._publish(job, force="state" in changes)

    def _publish(self, job: LaunchJob, force: bool = False) -> None:
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
            self.manager.bus.publish({"type": "launch",
                                      "data": {**j.summary(), "from": sent, "lines": j.lines_since(sent)}})

    # --------------------------------------------------------------- running
    async def _run(self, job: LaunchJob) -> None:
        mgr = self.manager
        self.log_dir.mkdir(parents=True, exist_ok=True)
        try:
            job.status = "running"
            job.started = time.time()
            job.phase = "getting the image and projects"
            ws = mgr._ws(job.ws_id)
            docs = [mgr.projects.get(pid) for pid in job.projects]
            self._line(job, f"» launching {ws.name}" + (f" with {', '.join(d['name'] for d in docs)}" if docs else ""))
            await self._warn_open_elsewhere(job, docs)
            paths: dict[str, str] = {}  # folder and drive projects: where they are
            await _all([self._image(job, ws, need_label=bool(docs)),
                        *(self._project(job, ws, d, paths) for d in docs)])
            job.progress = max(job.progress, STEP1_SHARE)
            job.phase = "starting"
            self._publish(job, force=True)
            await self._start(job, docs, paths)
            job.progress = 1.0
            job.status = "done"
            job.phase = "running"
            self._line(job, f"✓ {ws.name} is up")
        except asyncio.CancelledError:
            job.status = "cancelled"
            raise
        except Exception as e:  # image, git, disk, config: all end the job with a message
            log.warning("launch %s (%s) failed: %s", job.id, job.ws_id, e)
            job.status = "error"
            job.error = str(e)
            self._line(job, f"✗ {e}")
        finally:
            job.finished = time.time()
            self.tasks.pop(job.id, None)
            self._stopping.pop(job.id, None)
            self._publish(job, force=True)

    async def _image(self, job: LaunchJob, ws, need_label: bool) -> None:
        mgr = self.manager
        self._part(job, "image", state="working", message="checking the image")
        try:
            labels = await mgr.podman.image_labels(ws.image)
            if labels is None:
                if ws.image.startswith("localhost/"):
                    raise LaunchError(f"{ws.image} isn't on this machine; build {ws.name} in Wad Creator first")
                self._line(job, f"downloading {ws.image}")
                mirror = asyncio.create_task(self._mirror_pull(job, ws.id))
                try:
                    ok = await mgr.prefetch(ws.id)
                finally:
                    mirror.cancel()
                if not ok:
                    raise LaunchError(f"downloading {ws.image} failed: {mgr.states[ws.id].error}")
                labels = await mgr.podman.image_labels(ws.image) or {}
            if need_label and labels.get(PROJECTS_LABEL) != "1":
                raise LaunchError(OLD_BASE)
        except Exception as e:
            self._part(job, "image", state="error", message=str(e))
            raise
        self._part(job, "image", state="done", progress=1.0, message="ready")

    async def _mirror_pull(self, job: LaunchJob, ws_id: str) -> None:
        """The manager's download progress, onto the image's line."""
        while True:
            st = self.manager.states.get(ws_id)
            if st is not None and st.progress is not None:
                self._part(job, "image", progress=st.progress / 100, message=st.message)
            await asyncio.sleep(0.5)

    async def _warn_open_elsewhere(self, job: LaunchJob, docs: list[dict]) -> None:
        """A project open in a running workspace on another of the owner's
        machines (that is on): say so. Two copies edited at once end in git
        conflicts; it is a warning, not a refusal."""
        cloud = self.manager.cloud
        if not docs or cloud is None or not cloud.enrolled:
            return
        try:
            await cloud.load_siblings()
        except Exception as e:  # noqa: BLE001 - only a warning lost
            log.info("reading the other machines: %s", e)
            return
        for d in docs:
            if where := cloud.open_elsewhere(d["id"]):
                self._line(job, f"⚠ {d['mountName']} is open on {', '.join(where)}: stop it there first "
                                f"to avoid conflicts")

    async def _project(self, job: LaunchJob, ws, doc: dict, paths: dict[str, str]) -> None:
        mgr = self.manager
        d = mgr.cfg.daemon
        pid, mount = doc["id"], doc["mountName"]
        dest = project_dir(d.projects_dir, pid)
        source = doc.get("source") or {}
        self._part(job, pid, state="working", message="checking")
        try:
            if source.get("kind") in ("folder", "drive"):
                paths[pid], where = await self._host_folder(job, doc)
                self._part(job, pid, state="done", progress=1.0, message=where)
                return
            if dest.is_dir():
                self._part(job, pid, message="fetching")
                done = await self._update(job, doc, dest)
                self._part(job, pid, state="done", progress=1.0, message=done)
                return
            Path(d.projects_dir).mkdir(parents=True, exist_ok=True)
            old = await self._old_clone(ws, mount)
            if old is not None:
                await self._stop_for(job, ws, f"to move {mount} out of it")
                self._part(job, pid, message=f"moving the copy in {ws.name} over")
                await asyncio.to_thread(shutil.move, str(old), str(dest))
                await asyncio.to_thread(relabel, dest, True)
                self._line(job, f"{mount}: moved the copy {ws.name} had in ~/Desktop (changes kept) to {dest}")
            elif source.get("kind") == "git" and source.get("url"):
                await self._clone(job, doc, dest)
            else:
                raise LaunchError(f"{doc['name']}: {NOT_HERE}")
        except Exception as e:
            self._part(job, pid, state="error", message=str(e))
            raise
        self._part(job, pid, state="done", progress=1.0, message="on this machine")

    async def _host_folder(self, job: LaunchJob, doc: dict) -> tuple[str, str]:
        """A folder or drive project: (its path on this machine, the project
        line's message). LaunchError when it isn't here."""
        mgr = self.manager
        src, mount = doc["source"], doc["mountName"]
        if src["kind"] == "folder":
            if not mgr.folder_here(src):
                raise LaunchError(f"{doc['name']} is a folder on {src.get('machineName') or src.get('machineId')}")
            try:
                path = resolve_folder(src["path"], mgr.cfg.daemon.folder_roots)
            except OutsideRoots as e:
                raise LaunchError(f"{doc['name']}: {e}") from None
            if not Path(path).is_dir():
                raise LaunchError(f"folder {src['path']} is missing")
            self._line(job, f"{mount}: the folder {path}")
            return path, "folder on this machine"
        label = src.get("label") or src["uuid"]
        self._part(job, doc["id"], message=f"looking for the drive {label}")
        try:
            mountpoint = await mgr.drives.mount(src["uuid"], label, src.get("fstype") or "")
        except DriveError as e:
            raise LaunchError(str(e)) from None
        root = os.path.realpath(mountpoint)
        path = os.path.realpath(os.path.join(root, src.get("subpath") or ""))
        if path != root and not path.startswith(root.rstrip("/") + "/"):
            raise LaunchError(f"{doc['name']}: {src.get('subpath')} is outside the drive")
        if not Path(path).is_dir():
            raise LaunchError(f"folder {src.get('subpath') or '/'} is missing on {label}")
        self._line(job, f"{mount}: {path} on the drive {label}")
        return path, f"on the drive {label}"

    async def _update(self, job: LaunchJob, doc: dict, dest: Path) -> str:
        """Bring a copy that is here up to date when that is safe (see
        gitimport.update); the log says what happened and why. Returns the
        project line's message."""
        d = self.manager.cfg.daemon
        mount = doc["mountName"]
        token = await gitimport.find_token(self.manager.podman, d.secrets_dir) \
            if is_github_source(doc.get("source")) else None
        up = await gitimport.update(dest, token, d.projects_uid)
        plural = "commit" if up.count == 1 else "commits"
        line, message = {
            "updated": (f"{mount}: updated ({up.count} new {plural})", f"updated ({up.count} new {plural})"),
            "current": (f"{mount} is up to date", "up to date"),
            "dirty": (f"{mount} has uncommitted changes; not updated", "uncommitted changes — left as is"),
            "ahead": (f"{mount} has {up.count} unpushed {plural}; not updated",
                      f"{up.count} unpushed {plural} — left as is"),
            "no-upstream": (f"{mount} has no upstream branch; not updated", "no upstream branch — left as is"),
            "not-git": (f"{mount} is not a git repository; not updated", "not a git repo — left as is"),
            "offline": (f"⚠ {mount}: couldn't fetch ({up.error}); not updated", "couldn't fetch — left as is"),
            "stuck": (f"⚠ {mount}: couldn't fast-forward ({up.error}); not updated",
                      "couldn't fast-forward — left as is"),
        }[up.state]
        self._line(job, line)
        return message

    async def _clone(self, job: LaunchJob, doc: dict, dest: Path) -> None:
        mgr = self.manager
        d = mgr.cfg.daemon
        pid, src = doc["id"], doc["source"]
        token = await gitimport.find_token(mgr.podman, d.secrets_dir) if gitimport.is_github(src["url"]) else None
        self._line(job, f"{doc['mountName']}: cloning {src['url']}" + (f" ({src['ref']})" if src.get("ref") else ""))
        self._part(job, pid, message="cloning", progress=0.0)

        def on_line(text: str, fraction: float | None) -> None:
            if fraction is None:
                self._line(job, f"  {text}")
            else:
                self._part(job, pid, progress=fraction, message=text)
                if fraction >= 1.0 and "done" in text:
                    self._line(job, f"  {text}")

        await gitimport.clone(src["url"], src.get("ref"), dest, token, on_line, uid=d.projects_uid,
                              prepare=lambda p: make_owned_dir(p, d.projects_uid))

    async def _old_clone(self, ws, mount: str) -> Path | None:
        """Desktop/<mount> in the workspace's /config volume, if it has files:
        what an image from before projects cloned there."""
        vol = config_volume(ws.volumes)
        if not vol:
            return None
        try:
            mountpoint = await self.manager.podman.volume_mountpoint(vol)
        except Exception as e:  # noqa: BLE001 - nothing to move, then
            log.info("looking in volume %s: %s", vol, e)
            return None
        if not mountpoint:
            return None
        src = Path(mountpoint) / "Desktop" / mount
        try:
            if src.is_dir() and not src.is_symlink() and any(src.iterdir()):
                return src
        except OSError as e:
            log.info("looking at %s: %s", src, e)
        return None

    async def _stop_for(self, job: LaunchJob, ws, why: str) -> None:
        """Stop the workspace (once per launch) when it is running."""
        lock = self._stopping.setdefault(job.id, asyncio.Lock())
        async with lock:
            if self.manager.states[ws.id].container != "running":
                return
            if not job.restart:
                raise LaunchError(f"{ws.name} is running; pass restart to stop it {why}")
            self._line(job, f"stopping {ws.name} {why}")
            await self.manager.stop(ws.id)

    async def _start(self, job: LaunchJob, docs: list[dict], paths: dict[str, str]) -> None:
        mgr = self.manager
        d = mgr.cfg.daemon
        ws = mgr._ws(job.ws_id)
        wanted = [{"id": doc["id"], "mount": doc["mountName"],
                   **({"path": paths[doc["id"]]} if doc["id"] in paths else {})} for doc in docs]
        if wanted:
            write_manifest(d.state_dir, ws.id, [{"id": doc["id"], "name": doc["name"], "mount": doc["mountName"],
                                                 "setup": doc.get("setup") or ""} for doc in docs])
        if _project_set(ws.projects) != _project_set(wanted):
            await self._stop_for(job, ws, "to change its projects")
            await mgr.update_workspace(ws.id, {**mgr.spec_dict(ws.id), "projects": wanted})
            self._line(job, f"{ws.name} now mounts " + (", ".join(p["mount"] for p in wanted) or "no projects"))
        self._line(job, f"starting {ws.name}")
        await mgr.switch(ws.id)
        task = mgr.tasks.get(ws.id)
        if task is not None and not task.done():
            await asyncio.wait({task})
        st = mgr.states[ws.id]
        if st.phase == ERROR:
            raise LaunchError(st.error or f"{ws.name} did not start")


async def _all(coros: list) -> None:
    """gather, but the first failure cancels the rest (no clone carries on
    for a launch that already failed)."""
    tasks = [asyncio.ensure_future(c) for c in coros]
    try:
        await asyncio.gather(*tasks)
    except BaseException:
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        raise
