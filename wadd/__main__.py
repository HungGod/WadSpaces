"""wadd command line.

  wadd serve [--config PATH] [--dev] [--no-cdp] [--no-hotkeys]
  wadd gen-quadlets [--config PATH] --out DIR
  wadd secret set NAME        (value on stdin)
  wadd secret list | rm NAME
  wadd enroll CODE
  wadd status
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys

from . import __version__
from .config import ConfigError, load_config

DEFAULT_CONFIG = os.environ.get("WADD_CONFIG", "/etc/wadspaces/workspaces.yaml")
log = logging.getLogger("wadd")


def cmd_serve(args) -> int:
    import uvicorn

    from .api import create_app
    from .backends import make_backend
    from .display import SwayDisplay
    from .keyproxy import Chord, GrabProxy, KeyRouter
    from .kiosk import CdpClient, NullKiosk
    from .manager import WorkspaceManager
    from .network import NetworkManagerCli
    from .tailnet import Tailnet, TailnetWatch

    cfg = load_config(args.config)
    if args.dev:
        cfg.daemon.backend = "podman"
        cfg.daemon.podman_socket = f"/run/user/{os.getuid()}/podman/podman.sock"
        cfg.daemon.prefetch = "none"  # podman-compose created the containers already
    if args.port:
        cfg.daemon.port = args.port

    backend = make_backend(cfg)
    kiosk = NullKiosk() if args.no_cdp else CdpClient(cfg.daemon.cdp_url)
    manager = WorkspaceManager(cfg, backend, kiosk)
    net = NetworkManagerCli()
    if not args.dev and any(ws.native for ws in cfg.enabled_workspaces):
        # Native workspaces are windows on the kiosk session's sway.
        manager.display = SwayDisplay()
    # The trusted network: reported as not installed on a machine without
    # tailscaled (a dev laptop), and nothing else changes there.
    d = cfg.daemon
    manager.tailnet = TailnetWatch(manager, Tailnet(d.tailscale_socket, d.tailscale_bin, d.state_dir))

    async def boot():
        # A session saved before a restart comes back first. It needs the
        # event loop (its focus timer is a task), so it can't run earlier.
        try:
            manager.restore_session()
        except Exception:  # noqa: BLE001 - a bad session file must not stop wadd
            log.exception("restoring the saved session failed")
        # Units written by an older wadd (a host update keeps locally changed
        # files in /etc) are brought up to date, e.g. dropping a mount that's gone.
        if backend.name == "systemd":
            from .quadlet import gen_quadlets, quadlets_current
            try:
                if not quadlets_current(cfg, cfg.daemon.quadlet_dir):
                    gen_quadlets(cfg, cfg.daemon.quadlet_dir)
                    await backend.daemon_reload()
                    log.info("workspace units updated for this wadd")
            except Exception:  # noqa: BLE001 - old units still start
                log.exception("updating the workspace units failed")
        # Secrets next: autostart containers mount them.
        try:
            await manager.seed_secrets()
        except Exception:  # noqa: BLE001 - the daemon still works without them
            log.exception("seeding secrets failed")
        if cfg.daemon.prefetch != "none":
            await manager.prefetch_loop(net)

    background = [manager.refresh_loop, boot, lambda: manager.network_loop(net),
                  lambda: manager.display.run(manager.resolve_window, manager.on_native_window),
                  manager.tailnet.run]

    keys = cfg.daemon.keys
    if keys.enabled and not args.no_hotkeys:
        ok, why = GrabProxy.supported()
        if ok:
            async def run_keys():
                router = KeyRouter(manager.hotkey_bindings(), [Chord.parse(c) for c in keys.block],
                                   pass_super=keys.pass_super)
                manager.key_router = router
                # Grabbing a dev machine's keyboard would take it from the
                # desktop session, so --dev only watches for chords.
                proxy = GrabProxy(router, manager.on_hotkey, asyncio.get_running_loop(),
                                  grab=keys.grab and not args.dev)
                proxy.start()
                try:
                    while True:
                        manager.hotkey_devices = proxy.device_names
                        await asyncio.sleep(2)
                finally:
                    await asyncio.to_thread(proxy.stop)
            background.append(run_keys)
        else:
            log.warning("keyboard shortcuts disabled: %s", why)

    cloud = None
    if cfg.cloud:
        from .cloud import CloudRelay
        cloud = CloudRelay(cfg.cloud, manager, cfg.machine_name)
        background.append(cloud.run)

    app = create_app(manager, background, cloud, net)
    # The kiosk's SSE connection never closes on its own; without a graceful
    # timeout, stopping wadd (and so shutting down) waits for systemd's kill.
    servers = [uvicorn.Server(uvicorn.Config(app, host=cfg.daemon.bind, port=cfg.daemon.port,
                                             log_level="info", access_log=args.access_log,
                                             timeout_graceful_shutdown=3))]
    wc = cfg.wadcreator
    if wc.enabled:
        # Temporary: Wad Creator runs on this machine and calls the API above
        # directly. Later it moves to wadcreator.com and uses the cloud relay.
        from .api import create_wadcreator_app
        dist = args.wadcreator_dist or wc.dist
        servers.append(uvicorn.Server(uvicorn.Config(
            create_wadcreator_app(dist), host=wc.bind, port=wc.port,
            log_level="warning", access_log=False, timeout_graceful_shutdown=3)))
        log.info("Wad Creator from %s on http://%s:%d", dist, wc.bind, wc.port)
    log.info("wadd %s on %s (%d workspaces, backend %s)", __version__, cfg.daemon.base_url,
             len(cfg.enabled_workspaces), cfg.daemon.backend)

    async def run_all():
        await asyncio.gather(*(s.serve() for s in servers))
    asyncio.run(run_all())
    return 0


def cmd_gen_quadlets(args) -> int:
    from .quadlet import gen_quadlets
    cfg = load_config(args.config)
    for p in gen_quadlets(cfg, args.out, prune=not args.no_prune):
        print(p)
    return 0


def _podman(args):
    from .backends.podman import PodmanApi
    socket = args.socket or load_config(args.config).daemon.podman_socket
    return PodmanApi(socket)


def cmd_secret(args) -> int:
    async def run() -> int:
        api = _podman(args)
        try:
            if args.action == "set":
                value = sys.stdin.buffer.read()
                if value.endswith(b"\n") and not args.keep_newline:
                    value = value.rstrip(b"\r\n")
                if not value:
                    print("empty secret on stdin", file=sys.stderr)
                    return 1
                await api.create_secret(args.name, value, replace=True)
                print(f"secret {args.name} set")
            elif args.action == "list":
                for s in await api.list_secrets():
                    print((s.get("Spec") or {}).get("Name") or s.get("ID"))
            elif args.action == "rm":
                print("removed" if await api.delete_secret(args.name) else "not found")
            return 0
        finally:
            await api.close()
    return asyncio.run(run())


def cmd_enroll(args) -> int:
    from .cloud import CloudRelay
    cfg = load_config(args.config)
    if not cfg.cloud:
        print("no `cloud:` section in the config", file=sys.stderr)
        return 1

    async def run():
        relay = CloudRelay(cfg.cloud, None, cfg.machine_name)
        try:
            print(json.dumps(await relay.enroll(args.code), indent=2))
        finally:
            await relay.close()
    asyncio.run(run())
    print("restart wadd to start relaying: systemctl restart wadd")
    return 0


def cmd_status(args) -> int:
    import httpx
    cfg = load_config(args.config)
    try:
        r = httpx.get(f"{cfg.daemon.base_url}/api/workspaces", timeout=3)
        s = httpx.get(f"{cfg.daemon.base_url}/api/status", timeout=3).json()
    except httpx.HTTPError as e:
        print(f"wadd not reachable at {cfg.daemon.base_url}: {e}", file=sys.stderr)
        return 1
    print(f"{s['machine']}  view={s['view']}  kiosk={'up' if s['kiosk_connected'] else 'down'}  "
          f"backend={s['backend']}:{'up' if s['backend_connected'] else 'down'}  "
          f"enrolled={s['enrolled']}")
    for w in r.json():
        st = w["state"]
        hk = f"Super+{w['hotkey']}" if w["hotkey"] else ""
        print(f"  {w['id']:<16} {st['phase']:<9} {st['container']:<9} {w['url']:<24} {hk} "
              f"{st['error'] or ''}")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="wadd", description="WadSpaces workspace switcher daemon")
    ap.add_argument("--version", action="version", version=f"wadd {__version__}")
    ap.add_argument("--config", default=DEFAULT_CONFIG, help=f"(default {DEFAULT_CONFIG})")
    ap.add_argument("-v", "--verbose", action="store_true")
    sub = ap.add_subparsers(dest="cmd")

    s = sub.add_parser("serve", help="run the daemon (default)")
    s.add_argument("--dev", action="store_true",
                   help="drive containers made by podman-compose over the user podman socket")
    s.add_argument("--no-cdp", action="store_true", help="do not steer a kiosk browser")
    s.add_argument("--no-hotkeys", action="store_true")
    s.add_argument("--port", type=int)
    s.add_argument("--access-log", action="store_true")
    s.add_argument("--wadcreator-dist", help="built Wad Creator to serve (overrides wadcreator.dist)")
    s.set_defaults(func=cmd_serve)

    g = sub.add_parser("gen-quadlets", help="write wad-<id>.container units")
    g.add_argument("--out", default="/etc/containers/systemd")
    g.add_argument("--no-prune", action="store_true", help="keep stale wad-*.container files")
    g.set_defaults(func=cmd_gen_quadlets)

    sc = sub.add_parser("secret", help="manage podman secrets used by workspaces")
    sc.add_argument("--socket", help="podman socket (default: from config)")
    scs = sc.add_subparsers(dest="action", required=True)
    ss = scs.add_parser("set", help="read the value from stdin")
    ss.add_argument("name")
    ss.add_argument("--keep-newline", action="store_true")
    scs.add_parser("list")
    sr = scs.add_parser("rm")
    sr.add_argument("name")
    sc.set_defaults(func=cmd_secret)

    e = sub.add_parser("enroll", help="link this machine to Wad Creator with a one-time code")
    e.add_argument("code")
    e.set_defaults(func=cmd_enroll)

    st = sub.add_parser("status", help="show what the running daemon sees")
    st.set_defaults(func=cmd_status)

    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    from . import logbuffer
    logbuffer.install()
    if not args.cmd:
        args = ap.parse_args([*(argv or sys.argv[1:]), "serve"])
    try:
        return args.func(args)
    except ConfigError as e:
        print(f"config error: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
