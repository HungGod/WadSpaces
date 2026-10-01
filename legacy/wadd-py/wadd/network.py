"""Wifi through NetworkManager's nmcli, for the launcher's network menu.

wadd runs as root, so nmcli talks to NetworkManager over the system bus with no
polkit prompts. Output is read in terse mode with escaping on (`-t -e yes`):
fields are split on unescaped ':' and '\\:' / '\\\\' are unescaped.

Passwords are kept off command lines (other users can read /proc/*/cmdline):
the connection is added without one, then activated with a 0600 passwd-file.
If NetworkManager did not store the secret with the profile, it is set with
`connection modify` as a last resort so the network reconnects on boot.
"""
from __future__ import annotations

import asyncio
import logging
import os
import shutil
import tempfile

log = logging.getLogger(__name__)
NMCLI = "nmcli"


class NetworkError(RuntimeError):
    pass


def split_terse(line: str) -> list[str]:
    """Split one line of `nmcli -t -e yes` output into fields."""
    fields, cur, i = [], [], 0
    while i < len(line):
        c = line[i]
        if c == "\\" and i + 1 < len(line):
            cur.append(line[i + 1])
            i += 2
            continue
        if c == ":":
            fields.append("".join(cur))
            cur = []
        else:
            cur.append(c)
        i += 1
    fields.append("".join(cur))
    return fields


def key_mgmt(security: str) -> str | None:
    """nmcli SECURITY column -> wifi-sec.key-mgmt; '' for open networks,
    None for ones this menu can't join (enterprise, WEP)."""
    sec = security.upper()
    if not sec or sec == "--":
        return ""
    if "802.1X" in sec or "WEP" in sec:
        return None
    if "WPA" in sec and "WPA3" in sec and not any(v in sec for v in ("WPA1", "WPA2")):
        return "sae"
    return "wpa-psk"


def parse_wifi_list(out: str, known: set[str]) -> list[dict]:
    """IN-USE,SSID,SIGNAL,SECURITY rows -> one entry per SSID (strongest wins)."""
    best: dict[str, dict] = {}
    for line in out.splitlines():
        if not line.strip():
            continue
        f = split_terse(line)
        if len(f) < 4 or not f[1]:
            continue  # hidden network
        in_use, ssid, signal, security = f[0] == "*", f[1], int(f[2] or 0), f[3]
        prev = best.get(ssid)
        if prev and prev["signal"] >= signal and not in_use:
            prev["active"] = prev["active"] or in_use
            continue
        best[ssid] = {
            "ssid": ssid,
            "signal": signal,
            "security": security if security != "--" else "",
            "secure": bool(security and security != "--"),
            "supported": key_mgmt(security) is not None,
            "active": in_use or bool(prev and prev["active"]),
            "known": ssid in known,
        }
    return sorted(best.values(), key=lambda n: (not n["active"], -n["signal"], n["ssid"].lower()))


class NetworkManagerCli:
    def __init__(self, nmcli: str = NMCLI) -> None:
        self.nmcli = nmcli
        self._lock = asyncio.Lock()  # one nmcli change at a time

    @property
    def available(self) -> bool:
        return shutil.which(self.nmcli) is not None

    async def _run(self, *args: str, timeout: float = 15.0) -> str:
        proc = await asyncio.create_subprocess_exec(
            self.nmcli, *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            env={**os.environ, "LC_ALL": "C"})
        try:
            out, err = await asyncio.wait_for(proc.communicate(), timeout)
        except asyncio.TimeoutError:
            proc.kill()
            raise NetworkError(f"nmcli {args[0] if args else ''} timed out")
        if proc.returncode != 0:
            msg = (err or out).decode(errors="replace").strip()
            raise NetworkError(msg.removeprefix("Error: ") or f"nmcli failed ({proc.returncode})")
        return out.decode(errors="replace")

    async def _wifi_device(self) -> str | None:
        for line in (await self._run("-t", "-e", "yes", "-f", "DEVICE,TYPE", "device")).splitlines():
            f = split_terse(line)
            if len(f) >= 2 and f[1] == "wifi":
                return f[0]
        return None

    async def _known(self) -> set[str]:
        out = await self._run("-t", "-e", "yes", "-f", "NAME,TYPE", "connection", "show")
        return {f[0] for f in map(split_terse, out.splitlines()) if len(f) >= 2 and f[1] == "802-11-wireless"}

    async def connectivity(self) -> str:
        """none | portal | limited | full | unknown"""
        if not self.available:
            return "unknown"
        try:
            return (await self._run("networking", "connectivity")).strip() or "unknown"
        except NetworkError:
            return "unknown"

    async def status(self) -> dict:
        if not self.available:
            return {"available": False}
        f = split_terse((await self._run("-t", "-e", "yes", "-f", "STATE,CONNECTIVITY,WIFI", "general")).strip())
        status = {
            "available": True,
            "state": f[0] if f else "unknown",
            "connectivity": f[1] if len(f) > 1 else "unknown",
            "wifi_enabled": len(f) > 2 and f[2] == "enabled",
            "wifi_device": await self._wifi_device(),
            "ssid": None,
            "signal": None,
        }
        if status["wifi_device"]:
            out = await self._run("-t", "-e", "yes", "-f", "IN-USE,SSID,SIGNAL,SECURITY",
                                  "device", "wifi", "list", "--rescan", "no")
            for n in parse_wifi_list(out, set()):
                if n["active"]:
                    status["ssid"], status["signal"] = n["ssid"], n["signal"]
                    break
        return status

    async def scan(self) -> list[dict]:
        if not self.available:
            raise NetworkError("NetworkManager (nmcli) is not installed")
        out = await self._run("-t", "-e", "yes", "-f", "IN-USE,SSID,SIGNAL,SECURITY",
                              "device", "wifi", "list", "--rescan", "yes", timeout=30.0)
        return parse_wifi_list(out, await self._known())

    async def connect(self, ssid: str, password: str | None = None) -> None:
        async with self._lock:
            networks = {n["ssid"]: n for n in await self.scan()}
            net = networks.get(ssid)
            if net is None:
                raise NetworkError(f"network {ssid!r} is not in range")
            mgmt = key_mgmt(net["security"])
            if mgmt is None:
                raise NetworkError(f"{ssid}: {net['security']} networks are not supported here")
            if mgmt and net["known"] and not password:
                await self._run("connection", "up", "id", ssid, timeout=60.0)
                return
            if mgmt and not password:
                raise NetworkError("password required")
            if net["known"]:
                await self._run("connection", "delete", "id", ssid)
            add = ["connection", "add", "type", "wifi", "con-name", ssid, "ssid", ssid,
                   "connection.autoconnect", "yes"]
            if mgmt:
                add += ["wifi-sec.key-mgmt", mgmt]
            await self._run(*add)
            if not mgmt:
                await self._run("connection", "up", "id", ssid, timeout=60.0)
                return
            fd, path = tempfile.mkstemp(prefix="wadd-wifi-")
            try:
                with os.fdopen(fd, "w") as f:  # mkstemp files are 0600
                    f.write(f"802-11-wireless-security.psk:{password}\n")
                await self._run("connection", "up", "id", ssid, "passwd-file", path, timeout=60.0)
                saved = await self._run("-s", "-g", "802-11-wireless-security.psk",
                                        "connection", "show", "id", ssid)
                if not saved.strip():
                    # Not stored with the profile: set it so it survives a reboot.
                    log.info("wifi %s: storing psk with the profile", ssid)
                    await self._run("connection", "modify", "id", ssid, "wifi-sec.psk", password)
            except NetworkError:
                # Don't leave a profile with a wrong password autoconnecting.
                try:
                    await self._run("connection", "delete", "id", ssid)
                except NetworkError:
                    pass
                raise
            finally:
                os.unlink(path)

    async def disconnect(self) -> None:
        async with self._lock:
            dev = await self._wifi_device()
            if dev:
                await self._run("device", "disconnect", dev)

    async def forget(self, ssid: str) -> bool:
        async with self._lock:
            if ssid not in await self._known():
                return False
            await self._run("connection", "delete", "id", ssid)
            return True
