"""HTTP API + launcher/splash pages, served on 127.0.0.1:8080."""
from __future__ import annotations

import asyncio
import json
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlparse

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import __version__
from .config import ConfigError
from .manager import WorkspaceManager

log = logging.getLogger(__name__)
WEB = Path(__file__).parent / "web"


class NavigateBody(BaseModel):
    url: str


class EnrollBody(BaseModel):
    code: str


class SecretBody(BaseModel):
    value: str


def create_app(manager: WorkspaceManager, background: list | None = None, cloud=None) -> FastAPI:
    """background: coroutine factories run for the app's lifetime (refresh loop, hotkeys, cloud)."""
    cfg = manager.cfg
    own_origin = cfg.daemon.base_url
    trusted_origins = {own_origin, own_origin.replace("127.0.0.1", "localhost")}
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
    async def launcher_page():
        return FileResponse(WEB / "index.html", headers={"Cache-Control": "no-store"})

    @app.get("/starting/{ws_id}", include_in_schema=False)
    async def starting_page(ws_id: str):
        ws_or_404(ws_id)
        return FileResponse(WEB / "starting.html", headers={"Cache-Control": "no-store"})

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

    for name in ("switch", "start", "stop", "restart"):
        app.post(f"/api/workspaces/{{ws_id}}/{name}", status_code=202, dependencies=mutate)(action(name))

    @app.post("/api/launcher", status_code=202, dependencies=mutate)
    async def launcher():
        await manager.show_launcher()
        return {"ok": True}

    @app.post("/api/navigate", status_code=202, dependencies=mutate)
    async def navigate(body: NavigateBody):
        try:
            await manager.navigate(body.url)
        except PermissionError as e:
            raise HTTPException(403, str(e))
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
