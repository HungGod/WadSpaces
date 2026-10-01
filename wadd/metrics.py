"""How busy the machine is, for Wad Creator's Manager: CPU, memory, disk, GPU.

Read from /proc and /sys (no psutil). CPU is the share of busy time since the
previous call (or over a short sample on the first).
"""
from __future__ import annotations

import os
import shutil
import time
from pathlib import Path

_last_cpu: tuple[int, int] | None = None


def _cpu_times(proc: Path) -> tuple[int, int]:
    """(busy, total) jiffies from the aggregate cpu line."""
    first = (proc / "stat").read_text().splitlines()[0].split()[1:]
    vals = [int(v) for v in first]
    idle = vals[3] + (vals[4] if len(vals) > 4 else 0)  # idle + iowait
    total = sum(vals[:8])  # guest time is already counted in user/nice
    return total - idle, total


def cpu_percent(proc: Path = Path("/proc"), sample_s: float = 0.2) -> float:
    global _last_cpu
    now = _cpu_times(proc)
    before = _last_cpu
    if before is None:
        time.sleep(sample_s)
        before, now = now, _cpu_times(proc)
    _last_cpu = now
    busy, total = now[0] - before[0], now[1] - before[1]
    return round(100.0 * busy / total, 1) if total > 0 else 0.0


def memory(proc: Path = Path("/proc")) -> dict:
    info = {}
    for line in (proc / "meminfo").read_text().splitlines():
        k, _, v = line.partition(":")
        info[k] = int(v.split()[0]) * 1024  # kB
    total = info.get("MemTotal", 0)
    avail = info.get("MemAvailable", info.get("MemFree", 0))
    return {"total": total, "used": total - avail, "percent": round(100.0 * (total - avail) / total, 1) if total else 0.0}


def gpu_name(sys_drm: Path = Path("/sys/class/drm")) -> str:
    """The first GPU's kernel driver, e.g. "Intel (i915)"."""
    vendors = {"0x8086": "Intel", "0x1002": "AMD", "0x10de": "NVIDIA"}
    for card in sorted(sys_drm.glob("card[0-9]")):
        dev = card / "device"
        try:
            driver = os.path.basename(os.readlink(dev / "driver"))
        except OSError:
            continue
        vendor = ""
        try:
            vendor = vendors.get((dev / "vendor").read_text().strip(), "")
        except OSError:
            pass
        return f"{vendor} ({driver})" if vendor else driver
    return ""


def snapshot(disk_path: str = "/") -> dict:
    du = shutil.disk_usage(disk_path if os.path.exists(disk_path) else "/")
    mem = memory()
    return {
        "cpu": cpu_percent(),
        "mem": mem["percent"],
        "memUsed": mem["used"],
        "memTotal": mem["total"],
        "diskFree": du.free,
        "diskTotal": du.total,
        "load": os.getloadavg()[0],
        "gpu": gpu_name(),
    }
