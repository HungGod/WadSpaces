from __future__ import annotations

from ..config import Config
from .base import Backend, BackendError
from .podman import PodmanApi, PodmanBackend, PodmanError
from .systemd import SystemdBackend

__all__ = ["Backend", "BackendError", "PodmanApi", "PodmanBackend", "PodmanError",
           "SystemdBackend", "make_backend"]


def make_backend(cfg: Config) -> Backend:
    api = PodmanApi(cfg.daemon.podman_socket)
    if cfg.daemon.backend == "podman":
        return PodmanBackend(api)
    return SystemdBackend(api, scope=cfg.daemon.systemd_scope)
