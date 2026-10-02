"""HTTP API + the shell page the kiosk stays on, served on 127.0.0.1:8080."""
from __future__ import annotations

import asyncio
import json
import logging
import re
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlparse

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import __version__, logbuffer, metrics
from .builds import MAX_CONTEXT_BYTES, BuildError
from .config import ConfigError
from .drives import UUID_RE, DriveError, DriveMissing, OutsideRoots, browse, browse_inside
from .github import GitHubError
from .launches import LaunchError
from .library import LibraryError
from .manager import SessionLocked, WorkspaceManager
from .network import NetworkError
from .projects import ProjectConflict, ProjectError, mount_for, new_id, validate
from .tailnet import TailnetError

log = logging.getLogger(__name__)
WEB = Path(__file__).parent / "web"
GITHUB_NAME_RE = re.compile(r"^[A-Za-z0-9_.-]{1,100}$")


class NavigateBody(BaseModel):
    url: str


class EnrollBody(BaseModel):
    code: str


class SecretBody(BaseModel):
    value: str


class WifiConnectBody(BaseModel):
    ssid: str
    password: str | None = None


class WifiForgetBody(BaseModel):
    ssid: str


class KeyActionBody(BaseModel):
    action: str  # launcher | switch:<id> | carousel_next|prev|commit|cancel


class SessionBody(BaseModel):
    workspaces: list[str]
    minutes: int | None = None  # None: focus mode skipped


class SessionEndBody(BaseModel):
    force: bool = False  # end a focus session early


class HudBody(BaseModel):
    panel: str  # wifi | power


class PowerBody(BaseModel):
    action: str  # poweroff | reboot


class BuildBody(BaseModel):
    workspace: dict
    # The Dockerfile's `ARG BASE_IMAGE=` default; it must be on this machine.
    base_image: str = "localhost/wadspaces-base:trixie"


class GitHubRepoBody(BaseModel):
    name: str
    private: bool = True
    description: str = ""
    mountName: str | None = None  # default: the repo name, as a folder name
    setup: str = ""


class LaunchBody(BaseModel):
    workspace: str
    projects: list[str] = []
    view: str | None = None  # screen | stream; only the workspace's own display for now
    restart: bool = False    # stop it first if it's running with other projects


def create_app(manager: WorkspaceManager, background: list | None = None, cloud=None,
               net=None) -> FastAPI:
    """background: coroutine factories run for the app's lifetime (refresh loop, hotkeys, cloud).
    net: NetworkManagerCli for the wifi menu (None disables /api/network*)."""
    cfg = manager.cfg
    own_origin = cfg.daemon.base_url
    # app://wadcreator is Wad Creator's desktop app (WadCreator/desktop).
    trusted_origins = {own_origin, own_origin.replace("127.0.0.1", "localhost"), "app://wadcreator"}
    for u in [cfg.launcher.wadcreator_url, *cfg.launcher.allow_navigate]:
        if u:
            p = urlparse(u)
            trusted_origins.add(f"{p.scheme}://{p.netloc}")
    if cfg.wadcreator.enabled:
        for host in ("127.0.0.1", "localhost"):
            trusted_origins.add(f"http://{host}:{cfg.wadcreator.port}")

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        tasks = [asyncio.create_task(f()) for f in (background or [])]
        try:
            yield
        finally:
            for t in tasks:
                t.cancel()
            await manager.close()

    app = FastAPI(title="wadd", version=__version__, lifespan=lifespan,
                  docs_url="/api/docs", openapi_url="/api/openapi.json", redoc_url=None)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=sorted(trusted_origins),
        allow_methods=["GET", "POST", "PUT", "DELETE"],
        allow_headers=["Content-Type"],
    )

    async def same_or_trusted_origin(request: Request) -> None:
        """Mutations: browsers always send Origin cross-site, so a page the kiosk
        happens to show cannot drive the daemon unless it is trusted. Local CLI
        callers (curl, wadd) send no Origin and are allowed."""
        origin = request.headers.get("origin")
        if origin and origin not in trusted_origins:
            raise HTTPException(403, f"origin {origin} not allowed")

    mutate = [Depends(same_or_trusted_origin)]

    def ws_or_404(ws_id: str):
        try:
            return manager._ws(ws_id)
        except KeyError:
            raise HTTPException(404, f"no workspace {ws_id!r}")

    # ---------------------------------------------------------------- pages
    @app.get("/", include_in_schema=False)
    async def shell_page():
        return FileResponse(WEB / "index.html", headers={"Cache-Control": "no-store"})

    app.mount("/static", StaticFiles(directory=WEB), name="static")

    # ------------------------------------------------------------------ api
    @app.get("/api/health")
    async def health():
        return {"ok": True, "version": __version__}

    @app.get("/api/status")
    async def status():
        snap = manager.snapshot()
        snap.pop("workspaces")
        return snap

    @app.get("/api/workspaces")
    async def workspaces():
        return manager.snapshot()["workspaces"]

    @app.get("/api/workspaces/{ws_id}")
    async def workspace(ws_id: str):
        return manager.workspace_dict(ws_or_404(ws_id))

    @app.get("/api/icons/{ws_id}")
    async def icon(ws_id: str):
        ws = ws_or_404(ws_id)
        if not ws.icon or not Path(ws.icon).is_file():
            raise HTTPException(404)
        return FileResponse(ws.icon, headers={"Cache-Control": "max-age=3600"})

    def action(name: str):
        async def handler(ws_id: str):
            ws_or_404(ws_id)
            await getattr(manager, name)(ws_id)
            return JSONResponse({"ok": True, "workspace": manager.workspace_dict(ws_or_404(ws_id))},
                                status_code=202)
        handler.__name__ = f"{name}_workspace"
        return handler

    for name in ("switch", "start", "stop", "restart", "download"):
        app.post(f"/api/workspaces/{{ws_id}}/{name}", status_code=202, dependencies=mutate)(action(name))

    @app.post("/api/launcher", status_code=202, dependencies=mutate)
    async def launcher():
        try:
            await manager.show_launcher()
        except SessionLocked as e:
            raise HTTPException(409, str(e))
        return {"ok": True}

    @app.post("/api/navigate", status_code=202, dependencies=mutate)
    async def navigate(body: NavigateBody):
        try:
            await manager.navigate(body.url)
        except SessionLocked as e:
            raise HTTPException(409, str(e))
        except PermissionError as e:
            raise HTTPException(403, str(e))
        return {"ok": True}

    @app.post("/api/session", status_code=201, dependencies=mutate)
    async def begin_session(body: SessionBody):
        """Home's "what do you want to work on, and for how long" flow."""
        try:
            return await manager.session_begin(body.workspaces, body.minutes)
        except SessionLocked as e:
            raise HTTPException(409, str(e))
        except KeyError as e:
            raise HTTPException(404, f"no workspace {e.args[0]!r}")
        except ValueError as e:
            raise HTTPException(422, str(e))

    @app.post("/api/apps/wadcreator/open", status_code=202, dependencies=mutate)
    async def open_wadcreator():
        try:
            await manager.open_wadcreator()
        except SessionLocked as e:
            raise HTTPException(409, str(e))
        except RuntimeError as e:
            raise HTTPException(503, str(e))
        return {"ok": True}

    @app.post("/api/hud", status_code=202, dependencies=mutate)
    async def hud(body: HudBody):
        """The floating HUD's buttons: open that menu in the shell."""
        try:
            await manager.open_panel(body.panel)
        except ValueError as e:
            raise HTTPException(422, str(e))
        return {"ok": True}

    @app.post("/api/hud/closed", status_code=202, dependencies=mutate)
    async def hud_closed():
        await manager.panel_closed()
        return {"ok": True}

    @app.post("/api/session/end", dependencies=mutate)
    async def end_session(body: SessionEndBody | None = None):
        """Back to picking. Refused during focus time unless {"force": true}
        (the user chose to end it early)."""
        try:
            manager.end_session(force=bool(body and body.force))
        except SessionLocked as e:
            raise HTTPException(409, str(e))
        return {"ok": True}

    # ------------------------------------------------ CRUD (used by Wad Creator)
    @app.get("/api/specs")
    async def specs():
        """Full specs, including disabled workspaces (the editor's view)."""
        return [manager.spec_dict(ws.id) for ws in cfg.workspaces]

    @app.get("/api/specs/{ws_id}")
    async def spec(ws_id: str):
        try:
            return manager.spec_dict(ws_id)
        except KeyError:
            raise HTTPException(404, f"no workspace {ws_id!r}")

    @app.post("/api/workspaces", status_code=201, dependencies=mutate)
    async def create_workspace(body: dict):
        try:
            return await manager.create_workspace(body)
        except (ConfigError, TypeError) as e:
            raise HTTPException(422, str(e))

    @app.put("/api/workspaces/{ws_id}", dependencies=mutate)
    async def update_workspace(ws_id: str, body: dict):
        try:
            return await manager.update_workspace(ws_id, body)
        except KeyError:
            raise HTTPException(404, f"no workspace {ws_id!r}")
        except (ConfigError, TypeError) as e:
            raise HTTPException(422, str(e))

    @app.delete("/api/workspaces/{ws_id}", dependencies=mutate)
    async def delete_workspace(ws_id: str):
        try:
            await manager.delete_workspace(ws_id)
        except KeyError:
            raise HTTPException(404, f"no workspace {ws_id!r}")
        return {"ok": True}

    # ------------------------------------------ builds (Wad Creator's Build, offline)
    @app.get("/api/builds")
    async def builds():
        jobs = sorted(manager.builds.jobs.values(), key=lambda j: j.created, reverse=True)
        return [j.summary() for j in jobs]

    @app.post("/api/builds", status_code=201, dependencies=mutate)
    async def create_build(body: BuildBody):
        try:
            return manager.builds.create(body.workspace, body.base_image).summary()
        except (ConfigError, TypeError) as e:
            raise HTTPException(422, str(e))
        except BuildError as e:
            raise HTTPException(409, str(e))

    @app.put("/api/builds/{job_id}/context", status_code=202, dependencies=mutate)
    async def build_context(job_id: str, request: Request):
        """The build folder as a tar (raw body; no multipart needed)."""
        if int(request.headers.get("content-length") or 0) > MAX_CONTEXT_BYTES:
            raise HTTPException(413, "build folder too big (64 MB max)")
        data = await request.body()
        try:
            return manager.builds.start(job_id, data).summary()
        except KeyError:
            raise HTTPException(404, f"no build {job_id!r}")
        except BuildError as e:
            raise HTTPException(409, str(e))

    @app.get("/api/builds/{job_id}")
    async def build(job_id: str, since: int = 0):
        try:
            job = manager.builds.get(job_id)
        except KeyError:
            raise HTTPException(404, f"no build {job_id!r}")
        return {**job.summary(), "from": max(0, since), "lines": job.lines_since(max(0, since))}

    @app.delete("/api/builds/{job_id}", dependencies=mutate)
    async def cancel_build(job_id: str):
        try:
            return manager.builds.cancel(job_id).summary()
        except KeyError:
            raise HTTPException(404, f"no build {job_id!r}")

    # ------------------------------------------- projects (folders on the host)
    def project_or_404(pid: str) -> dict:
        try:
            return manager.projects.get(pid)
        except (KeyError, ProjectError):
            raise HTTPException(404, f"no project {pid!r}")

    def save_project(pid: str, body: dict) -> dict:
        try:
            doc = manager.projects.put(pid, body)
        except ProjectConflict as e:
            raise HTTPException(409, str(e))
        except ProjectError as e:
            raise HTTPException(422, str(e))
        manager.publish_projects([pid])
        return doc

    @app.get("/api/projects")
    async def projects(deleted: bool = False):
        """deleted=1 includes tombstones."""
        return manager.projects.list(include_deleted=deleted)

    @app.post("/api/projects", status_code=201, dependencies=mutate)
    async def create_project(body: dict):
        return save_project(new_id(), body)

    @app.get("/api/projects/{pid}")
    async def project(pid: str):
        return project_or_404(pid)

    @app.put("/api/projects/{pid}", dependencies=mutate)
    async def put_project(pid: str, body: dict):
        return save_project(pid, body)

    @app.delete("/api/projects/{pid}", dependencies=mutate)
    async def delete_project(pid: str, purge: bool = False):
        """Leaves a tombstone (it syncs); purge=1 also removes the folder."""
        project_or_404(pid)
        try:
            return await manager.delete_project(pid, purge)
        except ProjectConflict as e:
            raise HTTPException(409, str(e))

    @app.get("/api/projects/{pid}/status")
    async def project_status(pid: str):
        project_or_404(pid)
        return await manager.project_status(pid)

    # ------------------------------------- GitHub (where projects live)
    def github_http(e: GitHubError) -> HTTPException:
        return HTTPException(409 if e.no_token else 422 if e.status == 422 else 502, str(e))

    @app.get("/api/github")
    async def github():
        """{token, login}: is there a token, and whose. error: why there is
        no login although there is a token (refused, GitHub down)."""
        try:
            return {"token": True, **await manager.github.whoami()}
        except GitHubError as e:
            if e.no_token:
                return {"token": False, "login": None}
            return {"token": True, "login": None, "error": str(e)}

    @app.get("/api/github/repos")
    async def github_repos():
        try:
            login, repos = await manager.github.repos()
        except GitHubError as e:
            raise github_http(e)
        return {"login": login, "repos": repos}

    @app.post("/api/github/repos", status_code=201, dependencies=mutate)
    async def create_github_repo(body: GitHubRepoBody):
        """A new repo on GitHub (private unless asked), then a project for it."""
        name = body.name.strip()
        if not GITHUB_NAME_RE.match(name) or name in (".", ".."):
            raise HTTPException(422, f"repo name {name!r} may only use letters, digits, '.', '-' and '_'")
        pid = new_id()
        draft = {"name": name, "mountName": body.mountName or mount_for(name), "setup": body.setup,
                 "source": {"kind": "git", "url": f"https://github.com/o/{name}.git"}}
        try:  # everything that could refuse the project, before the repo exists
            validate(pid, draft)
            manager.projects.check_mount(pid, draft["mountName"])
        except ProjectConflict as e:
            raise HTTPException(409, str(e))
        except ProjectError as e:
            raise HTTPException(422, str(e))
        try:
            repo = await manager.github.create_repo(name, body.private, body.description)
        except GitHubError as e:
            raise github_http(e)
        doc = save_project(pid, {**draft, "source": {"kind": "git", "url": repo["url"]}})
        if manager.cloud is not None:
            manager.cloud.repos_due = True  # the online app's list gets it on the next poll
        return doc

    # ----------------------------------- drives and folders (folder pickers)
    @app.get("/api/drives")
    async def drives():
        """Filesystems a drive project could be on (not the system's disk)."""
        try:
            return await manager.drives.list()
        except DriveError as e:
            raise HTTPException(503, str(e))

    @app.get("/api/fs/browse")
    async def fs_browse(path: str | None = None, drive: str | None = None):
        """{path, parent, dirs: [{name, path}]}: the folders in path, inside
        daemon.folder_roots (no path: those roots). With drive=<uuid>, path is
        inside that drive (mounted first if needed) and so are the answers."""
        if drive is not None and not UUID_RE.match(drive):
            raise HTTPException(422, f"bad drive id {drive!r}")
        try:
            if drive:
                mountpoint = await manager.drives.mount(drive)
                return await asyncio.to_thread(browse_inside, mountpoint, path or "")
            return await asyncio.to_thread(browse, path, cfg.daemon.folder_roots)
        except OutsideRoots as e:
            raise HTTPException(403, str(e))
        except FileNotFoundError:
            raise HTTPException(404, f"no folder {path!r}")
        except PermissionError:
            raise HTTPException(403, f"can't read {path}")
        except DriveMissing as e:
            raise HTTPException(409, str(e))
        except DriveError as e:  # lsblk or the mount failed
            raise HTTPException(502, str(e))

    # ------------------------------------------- the trusted network (Tailscale)
    @app.get("/api/tailnet")
    async def tailnet():
        watch = manager.tailnet
        if watch is None:
            return {"installed": False, "streams": []}
        status = await watch.poll()
        return {**status, "streams": watch.streams()}

    def need_tailnet():
        if manager.tailnet is None or not manager.tailnet.client.installed:
            raise HTTPException(404, "Tailscale is not installed on this machine")
        return manager.tailnet

    @app.post("/api/tailnet/login", dependencies=mutate)
    async def tailnet_login():
        """{url}: open it (or scan it) to add this machine to your tailnet;
        null when it is already on."""
        watch = need_tailnet()
        try:
            out = await watch.client.login()
        except TailnetError as e:
            raise HTTPException(502, str(e))
        watch.kick()
        return out

    @app.post("/api/tailnet/logout", dependencies=mutate)
    async def tailnet_logout():
        watch = need_tailnet()
        try:
            await watch.client.logout()
        except TailnetError as e:
            raise HTTPException(502, str(e))
        watch.kick()
        return {"ok": True}

    # ------------------------------- launches (a workspace + its projects)
    @app.get("/api/launches")
    async def launches():
        jobs = sorted(manager.launches.jobs.values(), key=lambda j: j.created, reverse=True)
        return [j.summary() for j in jobs]

    @app.post("/api/launches", status_code=201, dependencies=mutate)
    async def create_launch(body: LaunchBody):
        try:
            return manager.launches.create(body.workspace, body.projects, body.view, body.restart).summary()
        except KeyError:
            raise HTTPException(404, f"no workspace {body.workspace!r}")
        except LaunchError as e:
            raise HTTPException(409, str(e))
        except ValueError as e:
            raise HTTPException(422, str(e))

    @app.get("/api/launches/{job_id}")
    async def launch(job_id: str, since: int = 0):
        try:
            job = manager.launches.get(job_id)
        except KeyError:
            raise HTTPException(404, f"no launch {job_id!r}")
        return {**job.summary(), "from": max(0, since), "lines": job.lines_since(max(0, since))}

    @app.delete("/api/launches/{job_id}", dependencies=mutate)
    async def cancel_launch(job_id: str):
        try:
            return manager.launches.cancel(job_id).summary()
        except KeyError:
            raise HTTPException(404, f"no launch {job_id!r}")

    # --------------------------------- Wad Creator's library (designs, drafts)
    @app.get("/api/library/{collection}")
    async def library_list(collection: str):
        try:
            return manager.library.list(collection)
        except LibraryError as e:
            raise HTTPException(404, str(e))

    @app.get("/api/library/{collection}/{doc_id}")
    async def library_get(collection: str, doc_id: str):
        try:
            return manager.library.get(collection, doc_id)
        except KeyError:
            raise HTTPException(404, f"no {doc_id!r} in {collection}")
        except LibraryError as e:
            raise HTTPException(404, str(e))

    @app.put("/api/library/{collection}/{doc_id}", dependencies=mutate)
    async def library_put(collection: str, doc_id: str, body: dict):
        try:
            return manager.library.put(collection, doc_id, body)
        except LibraryError as e:
            raise HTTPException(422, str(e))

    @app.delete("/api/library/{collection}/{doc_id}", dependencies=mutate)
    async def library_delete(collection: str, doc_id: str):
        try:
            if not manager.library.delete(collection, doc_id):
                raise HTTPException(404, f"no {doc_id!r} in {collection}")
        except LibraryError as e:
            raise HTTPException(404, str(e))
        return {"ok": True}

    # ------------------------------------------------ load and history (Manager)
    @app.get("/api/metrics")
    async def machine_metrics():
        return await asyncio.to_thread(metrics.snapshot, cfg.daemon.state_dir)

    @app.get("/api/runs")
    async def runs(workspace: str | None = None, limit: int = 200):
        return manager.runs.list(workspace, max(1, min(limit, 1000)))

    @app.get("/api/secrets")
    async def list_secrets():
        """Names only; values never leave podman."""
        return await manager.list_secrets()

    @app.put("/api/secrets/{name}", dependencies=mutate)
    async def set_secret(name: str, body: SecretBody):
        if not body.value:
            raise HTTPException(422, "empty value")
        await manager.set_secret(name, body.value)
        return {"ok": True}

    @app.delete("/api/secrets/{name}", dependencies=mutate)
    async def delete_secret(name: str):
        if not await manager.delete_secret(name):
            raise HTTPException(404, f"no secret {name!r}")
        return {"ok": True}

    @app.post("/api/enroll", dependencies=mutate)
    async def enroll(body: EnrollBody):
        if cloud is None:
            raise HTTPException(409, "cloud is not configured in workspaces.yaml")
        try:
            info = await cloud.enroll(body.code.strip())
        except Exception as e:  # noqa: BLE001 - shown on the launcher
            raise HTTPException(400, str(e))
        return {"ok": True, **info}

    @app.post("/api/keys/action", status_code=202, dependencies=mutate)
    async def key_action(body: KeyActionBody):
        """Do what a keyboard shortcut would (testing without a grabbed keyboard)."""
        ok = body.action in ("launcher", "carousel_next", "carousel_prev",
                             "carousel_commit", "carousel_cancel") or body.action.startswith("switch:")
        if not ok:
            raise HTTPException(422, f"unknown action {body.action!r}")
        await manager.on_hotkey(body.action)
        return {"ok": True, "carousel": manager.carousel}

    @app.post("/api/power", status_code=202, dependencies=mutate)
    async def power(body: PowerBody):
        try:
            await manager.power(body.action)
        except ValueError as e:
            raise HTTPException(422, str(e))
        except Exception as e:  # noqa: BLE001 - shown on the launcher
            raise HTTPException(500, str(e))
        return {"ok": True}

    # ---------------------------------------------------------- diagnostics
    # Read-only, and CORS keeps untrusted pages from reading them. Everything
    # is redacted: these are meant to be copied into a chat or an issue.
    def clamp(lines: int) -> int:
        return max(1, min(int(lines), 2000))

    @app.get("/api/diagnostics")
    async def diagnostics():
        data = await manager.diagnostics()
        return json.loads(logbuffer.redact(json.dumps(data)))

    @app.get("/api/logs/daemon")
    async def daemon_logs(lines: int = 200):
        ring = logbuffer.handler()
        return {"lines": ring.tail(clamp(lines)) if ring else []}

    @app.get("/api/logs/unit/{unit}")
    async def unit_logs(unit: str, lines: int = 200):
        try:
            text = await manager.unit_logs(unit, clamp(lines))
        except KeyError:
            raise HTTPException(404, f"no log for unit {unit!r}; try one of {manager.log_units()}")
        except Exception as e:  # noqa: BLE001
            raise HTTPException(503, str(e))
        return {"text": logbuffer.redact(text)}

    @app.get("/api/logs/workspace/{ws_id}")
    async def workspace_logs(ws_id: str, lines: int = 200):
        try:
            text = await manager.workspace_logs(ws_id, clamp(lines))
        except KeyError:
            raise HTTPException(404, f"no workspace {ws_id!r}")
        except Exception as e:  # noqa: BLE001
            raise HTTPException(503, str(e))
        return {"text": logbuffer.redact(text)}

    # ------------------------------------------------------------- network
    def need_net():
        if net is None:
            raise HTTPException(404, "network management is disabled")
        return net

    async def refresh_network() -> None:
        try:
            manager.network = await need_net().status()
            manager.publish()
        except NetworkError:
            pass

    @app.get("/api/network")
    async def network():
        try:
            return await need_net().status()
        except NetworkError as e:
            raise HTTPException(502, str(e))

    @app.get("/api/network/wifi")
    async def wifi_scan():
        try:
            return await need_net().scan()
        except NetworkError as e:
            raise HTTPException(502, str(e))

    @app.post("/api/network/wifi/connect", dependencies=mutate)
    async def wifi_connect(body: WifiConnectBody):
        try:
            await need_net().connect(body.ssid, body.password or None)
        except NetworkError as e:
            raise HTTPException(400, str(e))
        await refresh_network()
        return {"ok": True}

    @app.post("/api/network/wifi/disconnect", dependencies=mutate)
    async def wifi_disconnect():
        try:
            await need_net().disconnect()
        except NetworkError as e:
            raise HTTPException(400, str(e))
        await refresh_network()
        return {"ok": True}

    @app.post("/api/network/wifi/forget", dependencies=mutate)
    async def wifi_forget(body: WifiForgetBody):
        try:
            if not await need_net().forget(body.ssid):
                raise HTTPException(404, f"no saved network {body.ssid!r}")
        except NetworkError as e:
            raise HTTPException(400, str(e))
        await refresh_network()
        return {"ok": True}

    @app.get("/api/events")
    async def events(request: Request):
        q = manager.bus.subscribe()

        async def stream():
            try:
                yield f"event: state\ndata: {json.dumps(manager.snapshot())}\n\n"
                while True:
                    if await request.is_disconnected():
                        break
                    try:
                        ev = await asyncio.wait_for(q.get(), timeout=15.0)
                        yield f"event: {ev['type']}\ndata: {json.dumps(ev['data'])}\n\n"
                    except asyncio.TimeoutError:
                        yield ": keepalive\n\n"
            finally:
                manager.bus.unsubscribe(q)

        return StreamingResponse(stream(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})

    return app


def create_wadcreator_app(dist: str) -> FastAPI:
    """Serve a built Wad Creator (Vite dist/) as an SPA on its own origin."""
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    root = Path(dist)
    index = root / "index.html"

    @app.get("/{path:path}", include_in_schema=False)
    async def spa(path: str):
        f = (root / path).resolve()
        if path and f.is_file() and root.resolve() in f.parents:
            return FileResponse(f)
        if index.is_file():
            return FileResponse(index, headers={"Cache-Control": "no-store"})
        return JSONResponse({"error": f"Wad Creator is not installed at {root}"}, status_code=503)

    return app
