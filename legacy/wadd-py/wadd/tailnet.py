"""Tailscale, the trusted network between the owner's machines.

Reading goes through tailscaled's LocalAPI on its unix socket (no auth over
the socket; the Host header must be local-tailscaled.sock):
  GET /localapi/v0/status          -> online, 100.x address, MagicDNS name
  GET /localapi/v0/whois?addr=ip:port -> which node (and user) is calling
  GET /localapi/v0/serve-config    -> what `tailscale serve` is serving
Changes go through the `tailscale` CLI (its flags are the stable interface):
login, logout, `up --auth-key=file:...` (the key is never on a command line,
which other users can read in /proc), and `serve --bg --https=<port>` for
stream workspaces. Never Funnel: the streams are for the tailnet only.

Without tailscaled (a dev laptop) the status is {"installed": false} and
nothing else is tried. TailnetWatch keeps the status fresh and the running
stream workspaces served.
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
import shutil
import tempfile
from pathlib import Path

import httpx

log = logging.getLogger(__name__)

HOST = "http://local-tailscaled.sock"
LOGIN_URL_RE = re.compile(r"https://login\.tailscale\.com/\S+")
LOGIN_WAIT_S = 30   # for the login URL to appear
LOGIN_TIMEOUT = "10m"  # how long `tailscale login` waits for you to finish


class TailnetError(RuntimeError):
    pass


def parse_status(st: dict) -> dict:
    """The LocalAPI status, cut down to what wadd and Wad Creator use."""
    me = st.get("Self") or {}
    state = st.get("BackendState") or "NoState"
    ips = [ip for ip in (me.get("TailscaleIPs") or st.get("TailscaleIPs") or []) if ip.startswith("100.")]
    user = (st.get("User") or {}).get(str(me.get("UserID"))) or {}
    return {
        "installed": True,
        "running": True,
        "backendState": state,
        "online": state == "Running",
        "loggedIn": state not in ("NeedsLogin", "NoState"),
        "ip": ips[0] if ips else None,
        "dnsName": (me.get("DNSName") or "").rstrip(".") or None,
        "stableId": me.get("ID") or None,
        "hostName": me.get("HostName") or None,
        "loginName": user.get("LoginName") or None,
    }


def served_ports(serve_config: dict) -> set[int]:
    """Ports `tailscale serve` proxies to 127.0.0.1 on the same port: the
    ones wadd serves (anything else there was set up by hand and is left be)."""
    out = set()
    for hostport, web in ((serve_config or {}).get("Web") or {}).items():
        port = hostport.rsplit(":", 1)[-1]
        if not port.isdigit():
            continue
        proxy = (((web or {}).get("Handlers") or {}).get("/") or {}).get("Proxy") or ""
        if proxy.rstrip("/") == f"http://127.0.0.1:{port}":
            out.add(int(port))
    return out


class Tailnet:
    def __init__(self, socket_path: str = "/run/tailscale/tailscaled.sock", cli: str = "tailscale",
                 state_dir: str | Path = "/var/lib/wadspaces", transport: httpx.AsyncBaseTransport | None = None):
        self.socket_path = socket_path
        self.cli = cli
        self.state_dir = Path(state_dir)
        self._transport = transport
        self._client: httpx.AsyncClient | None = None
        self._login: asyncio.Task | None = None  # `tailscale login` waiting for the browser

    # ---------------------------------------------------------------- LocalAPI
    @property
    def installed(self) -> bool:
        return (self._transport is not None or os.path.exists(self.socket_path)
                or shutil.which(self.cli) is not None)

    def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            transport = self._transport or httpx.AsyncHTTPTransport(uds=self.socket_path)
            self._client = httpx.AsyncClient(transport=transport, base_url=HOST, timeout=10.0)
        return self._client

    async def _get(self, path: str, **params) -> httpx.Response:
        try:
            return await self._http().get(f"/localapi/v0/{path}", params=params or None)
        except (httpx.HTTPError, OSError) as e:
            raise TailnetError(f"tailscaled: {e}") from e

    async def status(self) -> dict:
        if not self.installed:
            return {"installed": False}
        try:
            r = await self._get("status")
            r.raise_for_status()
            return parse_status(r.json())
        except (TailnetError, httpx.HTTPError, ValueError) as e:
            log.debug("tailnet status: %s", e)
            return {"installed": True, "running": False, "online": False, "loggedIn": False}

    async def whois(self, addr: str) -> dict | None:
        """Who is at addr ("100.x.y.z:port"): {stableId, nodeName, loginName}.
        None when it isn't a tailnet peer."""
        r = await self._get("whois", addr=addr)
        if r.status_code in (400, 404):
            return None
        if r.status_code != 200:
            raise TailnetError(f"whois {addr}: {r.status_code} {r.text[:200]}")
        body = r.json()
        node = body.get("Node") or {}
        return {"stableId": node.get("StableID") or None,
                "nodeName": (node.get("Name") or "").rstrip(".") or None,
                "loginName": (body.get("UserProfile") or {}).get("LoginName") or None}

    async def served_ports(self) -> set[int]:
        r = await self._get("serve-config")
        if r.status_code != 200:
            raise TailnetError(f"serve-config: {r.status_code} {r.text[:200]}")
        return served_ports(r.json() if r.content.strip() else {})

    # --------------------------------------------------------------------- CLI
    async def _run(self, *args: str, timeout: float = 30.0) -> str:
        try:
            proc = await asyncio.create_subprocess_exec(
                self.cli, *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
        except OSError as e:
            raise TailnetError(f"tailscale: {e}") from e
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), timeout)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            raise TailnetError(f"tailscale {args[0]} timed out") from None
        text = out.decode(errors="replace").strip()
        if proc.returncode != 0:
            raise TailnetError(text or f"tailscale {args[0]} failed ({proc.returncode})")
        return text

    async def login(self) -> dict:
        """Start an interactive login and return its URL ({"url"}), to open or
        show as a QR code. `tailscale login` keeps running in the background
        until the login is finished (or LOGIN_TIMEOUT). Already online: no URL."""
        st = await self.status()
        if not st.get("installed"):
            raise TailnetError("Tailscale is not installed on this machine")
        if st.get("online"):
            return {"url": None, "online": True}
        if self._login is not None and not self._login.done():
            self._login.cancel()
        try:
            proc = await asyncio.create_subprocess_exec(
                self.cli, "login", f"--timeout={LOGIN_TIMEOUT}",
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
        except OSError as e:
            raise TailnetError(f"tailscale: {e}") from e
        seen: list[str] = []
        url = None
        try:
            async with asyncio.timeout(LOGIN_WAIT_S):
                while url is None:
                    line = await proc.stdout.readline()
                    if not line:
                        break
                    text = line.decode(errors="replace").strip()
                    seen.append(text)
                    if m := LOGIN_URL_RE.search(text):
                        url = m.group(0)
        except TimeoutError:
            pass
        if url is None:
            if proc.returncode is None:
                proc.kill()
            code = await proc.wait()
            if code == 0:
                return {"url": None, "online": True}
            raise TailnetError(" ".join(t for t in seen if t) or "tailscale login gave no URL")
        self._login = asyncio.ensure_future(self._finish_login(proc))
        return {"url": url, "online": False}

    @staticmethod
    async def _finish_login(proc) -> None:
        try:
            while await proc.stdout.readline():
                pass  # keep the pipe drained until it exits
            await proc.wait()
        except asyncio.CancelledError:
            if proc.returncode is None:
                proc.kill()
            raise

    async def logout(self) -> None:
        await self._run("logout")

    async def up_with_authkey(self, key: str) -> None:
        """Join with an auth key, passed in a 0600 file, never on argv."""
        self.state_dir.mkdir(parents=True, exist_ok=True)
        fd, path = tempfile.mkstemp(prefix=".tailscale-authkey-", dir=self.state_dir)
        try:
            with os.fdopen(fd, "w") as f:  # mkstemp files are 0600
                f.write(key.strip())
            await self._run("up", f"--auth-key=file:{path}", timeout=90.0)
        finally:
            os.unlink(path)

    async def serve(self, port: int) -> None:
        await self._run("serve", "--bg", f"--https={int(port)}", f"http://127.0.0.1:{int(port)}")

    async def unserve(self, port: int) -> None:
        await self._run("serve", f"--https={int(port)}", "off")

    async def close(self) -> None:
        if self._login is not None and not self._login.done():
            self._login.cancel()
        if self._client is not None:
            await self._client.aclose()


class TailnetWatch:
    """Keeps `status` fresh and the running stream workspaces served on the
    tailnet. Polls every `interval` seconds, and at once when a container
    starts or stops (kick(), from the manager)."""

    def __init__(self, manager, client: Tailnet, interval: float = 15.0) -> None:
        self.manager = manager
        self.client = client
        self.interval = interval
        self.status: dict = {"installed": False}
        self.served: set[int] = set()  # ports wadd serves right now
        self._kick = asyncio.Event()

    def kick(self) -> None:
        self._kick.set()

    async def poll(self) -> dict:
        status = await self.client.status()
        if status != self.status:
            came_online = status.get("online") and not self.status.get("online")
            self.status = status
            self.manager.bus.publish({"type": "tailnet", "data": status})
            if came_online:
                log.info("tailnet: online as %s (%s)", status.get("dnsName"), status.get("ip"))
        return status

    def wanted_ports(self) -> set[int]:
        if not self.manager.cfg.daemon.tailnet_streams or not self.status.get("online"):
            return set()
        return {ws.port for ws in self.manager.cfg.enabled_workspaces
                if not ws.native and ws.port and ws.id in self.manager.states
                and self.manager.states[ws.id].container == "running"}

    async def reconcile(self) -> None:
        """serve what should be served, unserve what no longer should (only
        the ports of workspaces: other serve entries aren't wadd's)."""
        if not self.status.get("online"):
            self.served = set()
            return
        current = await self.client.served_ports()
        ours = {ws.port for ws in self.manager.cfg.workspaces if ws.port}
        wanted = self.wanted_ports()
        for port in sorted(wanted - current):
            try:
                await self.client.serve(port)
                current.add(port)
                log.info("tailnet: serving :%d", port)
            except TailnetError as e:
                log.warning("tailnet: serving :%d failed: %s", port, e)
        for port in sorted((current & ours) - wanted):
            try:
                await self.client.unserve(port)
                current.discard(port)
                log.info("tailnet: stopped serving :%d", port)
            except TailnetError as e:
                log.warning("tailnet: unserving :%d failed: %s", port, e)
        self.served = current & wanted

    def streams(self) -> list[dict]:
        """[{wsId, url}] for the stream workspaces served on the tailnet."""
        dns = self.status.get("dnsName")
        if not dns:
            return []
        return [{"wsId": ws.id, "url": f"https://{dns}:{ws.port}/"}
                for ws in self.manager.cfg.enabled_workspaces
                if not ws.native and ws.port in self.served]

    async def run(self) -> None:
        while True:
            self._kick.clear()
            try:
                await self.poll()
                await self.reconcile()
            except Exception as e:  # noqa: BLE001 - try again next round
                log.warning("tailnet: %s", e)
            try:
                await asyncio.wait_for(self._kick.wait(), self.interval)
            except asyncio.TimeoutError:
                pass
