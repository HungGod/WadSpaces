"""Download progress for image pulls.

Podman's pull API can't drive a progress bar: it prints "Copying blob <digest>"
for every layer at once when the parallel downloads *start*, then nothing
until the pull ends. So wadd measures it itself:

  total  = sizes of the image's layers, from the registry's manifest, minus
           layers podman already has (overlay-layers/layers.json records each
           local layer's compressed digest, which matches the manifest's)
  done   = bytes received on the machine's real network interfaces since the
           pull started (/sys/class/net/*/statistics/rx_bytes)

"done" counts any other traffic too, so it is capped below 100% until podman
says the pull finished. Any failure here only loses the bar, never the pull.
"""
from __future__ import annotations

import base64
import json
import logging
import os
import platform
import re
import time
from dataclasses import dataclass, field
from pathlib import Path

import httpx

log = logging.getLogger(__name__)

MANIFEST_TYPES = ", ".join([
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.docker.distribution.manifest.v2+json",
])
INDEX_TYPES = ("application/vnd.oci.image.index.v1+json",
               "application/vnd.docker.distribution.manifest.list.v2+json")
AUTH_FILES = [
    os.environ.get("REGISTRY_AUTH_FILE", ""),
    f"/run/containers/{os.getuid()}/auth.json",
    f"/run/user/{os.getuid()}/containers/auth.json",
    os.path.expanduser("~/.config/containers/auth.json"),
    os.path.expanduser("~/.docker/config.json"),
]
# Interfaces whose traffic isn't the pull (or counts it twice).
VIRTUAL_IF = re.compile(r"^(lo|veth|podman|cni|virbr|docker|br-|tun|tap|wg|vnet)")
DONE_CAP = 0.99  # "done" includes other traffic: never claim 100% early
ETA_AFTER = 0.02  # the first seconds' rate is meaningless: no estimate before 2%
UNPACK_IDLE_S = 3.0  # bytes stopped arriving near the end: podman is unpacking


def parse_ref(ref: str) -> tuple[str, str, str]:
    """'ghcr.io/o/n:tag' -> ('ghcr.io', 'o/n', 'tag'); Docker Hub short names too."""
    name, reference = ref, "latest"
    if "@" in name:
        name, reference = name.split("@", 1)
    else:
        last = name.rsplit("/", 1)[-1]
        if ":" in last:
            name, reference = name.rsplit(":", 1)
    first = name.split("/", 1)[0]
    if "/" in name and ("." in first or ":" in first or first == "localhost"):
        registry, repo = name.split("/", 1)
    else:
        registry, repo = "docker.io", name
    if registry == "docker.io" and "/" not in repo:
        repo = f"library/{repo}"
    return registry, repo, reference


def _api_host(registry: str) -> str:
    return "registry-1.docker.io" if registry == "docker.io" else registry


def parse_challenge(header: str) -> dict[str, str]:
    """WWW-Authenticate: Bearer realm="...",service="...",scope="..." -> dict."""
    return {k.lower(): v for k, v in re.findall(r'(\w+)="([^"]*)"', header)}


def registry_credentials(registry: str, files: list[str] | None = None) -> tuple[str, str] | None:
    for path in files if files is not None else AUTH_FILES:
        if not path or not os.path.isfile(path):
            continue
        try:
            auths = json.loads(Path(path).read_text()).get("auths", {})
        except (OSError, ValueError):
            continue
        for key in (registry, f"https://{registry}", "https://index.docker.io/v1/" if registry == "docker.io" else ""):
            entry = auths.get(key) if key else None
            if entry and entry.get("auth"):
                user, _, password = base64.b64decode(entry["auth"]).decode().partition(":")
                return user, password
    return None


def _arch() -> str:
    return {"x86_64": "amd64", "aarch64": "arm64"}.get(platform.machine(), platform.machine())


async def fetch_layer_sizes(ref: str, client: httpx.AsyncClient | None = None,
                            auth_files: list[str] | None = None) -> dict[str, int] | None:
    """{blob digest: compressed size} for the image's layers, or None."""
    registry, repo, reference = parse_ref(ref)
    base = f"https://{_api_host(registry)}/v2/{repo}"
    own = client is None
    client = client or httpx.AsyncClient(timeout=10.0, follow_redirects=True)
    headers = {"Accept": MANIFEST_TYPES}
    try:
        async def get(url: str) -> httpx.Response:
            r = await client.get(url, headers=headers)
            if r.status_code == 401 and "authorization" not in headers:
                ch = parse_challenge(r.headers.get("www-authenticate", ""))
                if ch.get("realm"):
                    creds = registry_credentials(registry, auth_files)
                    params = {k: ch[k] for k in ("service", "scope") if k in ch}
                    params.setdefault("scope", f"repository:{repo}:pull")
                    t = await client.get(ch["realm"], params=params, auth=creds)
                    t.raise_for_status()
                    body = t.json()
                    headers["authorization"] = f"Bearer {body.get('token') or body.get('access_token')}"
                    r = await client.get(url, headers=headers)
            r.raise_for_status()
            return r

        manifest = (await get(f"{base}/manifests/{reference}")).json()
        if manifest.get("mediaType") in INDEX_TYPES or "manifests" in manifest:
            want = _arch()
            pick = next((m for m in manifest.get("manifests", [])
                         if (m.get("platform") or {}).get("architecture") == want
                         and (m.get("platform") or {}).get("os", "linux") == "linux"), None)
            if pick is None:
                return None
            manifest = (await get(f"{base}/manifests/{pick['digest']}")).json()
        return {l["digest"]: int(l["size"]) for l in manifest.get("layers", [])}
    except (httpx.HTTPError, ValueError, KeyError) as e:
        log.info("no layer sizes for %s: %s", ref, e)
        return None
    finally:
        if own:
            await client.aclose()


def local_blob_digests(graph_root: str) -> set[str]:
    """Compressed digests of the layers podman already has."""
    try:
        layers = json.loads((Path(graph_root) / "overlay-layers" / "layers.json").read_text())
    except (OSError, ValueError):
        return set()
    return {l["compressed-diff-digest"] for l in layers if l.get("compressed-diff-digest")}


def rx_bytes(net_dir: str = "/sys/class/net") -> int:
    """Bytes received on the real interfaces (not loopback, bridges, veths)."""
    total = 0
    try:
        names = os.listdir(net_dir)
    except OSError:
        return 0
    for name in names:
        if VIRTUAL_IF.match(name):
            continue
        try:
            total += int(Path(net_dir, name, "statistics", "rx_bytes").read_text())
        except (OSError, ValueError):
            pass
    return total


@dataclass
class PullProgress:
    """Turns counter samples into what the UI shows. Pure: feed it numbers."""
    total_bytes: int | None     # still to download; None: sizes unknown
    layers: int = 0             # layers in the image
    rx_start: int = 0
    t_start: float = field(default_factory=time.monotonic)
    done_bytes: int = 0
    received: int = 0           # this pull's share of rx bytes so far
    rate_bps: float = 0.0
    unpacking: bool = False
    _last: tuple[float, int] | None = None
    _moved_at: float | None = None

    def sample(self, rx: int, now: float | None = None) -> None:
        now = time.monotonic() if now is None else now
        got = max(0, rx - self.rx_start)
        if self.total_bytes is not None:
            got = min(got, int(self.total_bytes * DONE_CAP))
        if self._last is not None:
            dt = now - self._last[0]
            if dt > 0:
                inst = max(0, got - self._last[1]) / dt
                # ~10 s smoothing at one sample a second
                self.rate_bps = inst if self.rate_bps == 0 else 0.9 * self.rate_bps + 0.1 * inst
        if self._last is None or got > self._last[1]:
            self._moved_at = now
        self._last = (now, got)
        self.done_bytes = got
        # Downloads done, layers being unpacked: rate and ETA stop meaning much.
        near_end = self.total_bytes is not None and got >= 0.9 * self.total_bytes
        self.unpacking = near_end and self._moved_at is not None and now - self._moved_at >= UNPACK_IDLE_S

    @property
    def percent(self) -> int | None:
        if not self.total_bytes:
            return None
        return int(100 * self.done_bytes / self.total_bytes)

    @property
    def eta_s(self) -> int | None:
        if not self.total_bytes or self.rate_bps < 1 or self.unpacking:
            return None
        if self.done_bytes < ETA_AFTER * self.total_bytes:
            return None
        return int((self.total_bytes - self.done_bytes) / self.rate_bps)

    def to_dict(self) -> dict:
        return {"total_bytes": self.total_bytes, "done_bytes": self.done_bytes,
                "layers": self.layers, "rate_bps": 0 if self.unpacking else int(self.rate_bps),
                "eta_s": self.eta_s, "unpacking": self.unpacking}

    def finish(self) -> None:
        if self.total_bytes is not None:
            self.done_bytes = self.total_bytes


def human_bytes(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1000 or unit == "GB":
            return f"{n:.0f} {unit}" if unit in ("B", "KB") else f"{n:.1f} {unit}"
        n /= 1000
    return f"{n:.1f} GB"


def describe(p: PullProgress) -> str:
    """'1.9 GB of 5.3 GB · 12.0 MB/s · about 4 min left'"""
    if p.total_bytes is None:
        return f"downloading {p.layers} layers" if p.layers else "downloading"
    if p.total_bytes == 0:
        return "already downloaded, unpacking"
    if p.unpacking:
        return f"downloaded {human_bytes(p.done_bytes)}, unpacking"
    bits = [f"{human_bytes(p.done_bytes)} of {human_bytes(p.total_bytes)}"]
    if p.rate_bps >= 1000 and p.done_bytes >= ETA_AFTER * p.total_bytes:
        bits.append(f"{human_bytes(p.rate_bps)}/s")
    eta = p.eta_s
    if eta is not None:
        bits.append("about " + (f"{eta // 60} min left" if eta >= 90 else f"{max(eta, 1)} s left"))
    return " · ".join(bits)
