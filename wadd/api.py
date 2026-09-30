"""HTTP API + the shell page the kiosk stays on, served on 127.0.0.1:8080."""
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

from . import __version__, logbuffer
from .config import ConfigError
from .manager import SessionLocked, WorkspaceManager
from .network import NetworkError

log = logging.getLogger(__name__)
WEB = Path(__file__).parent / "web"


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


class HudBody(BaseModel):
    panel: str  # wifi | power


class PowerBody(BaseModel):
    action: str  # poweroff | reboot


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
    async def end_session():
        """Home's "New session": back to picking. Refused during focus time."""
        try:
            manager.end_session()
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
