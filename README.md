# Workspace-Switcher

The host side of WadSpaces: a bootable Fedora image that boots straight into a
fullscreen browser, and `wadd`, the daemon that moves that browser between
isolated workspace containers.

```
greetd ─► cage ─► chromium --kiosk --remote-debugging-port=9222
                        ▲ Chrome DevTools Protocol: Page.navigate
wadd (root, 127.0.0.1:8080)
  ├─ launcher page /  and  splash /starting/<id>
  ├─ REST + server-sent events  /api/*
  ├─ hotkeys from /dev/input: Super+1..9, Super+0 / Super+Space
  ├─ systemctl start wad-<id>.service   (podman quadlets, not auto-started)
  ├─ podman REST socket: state, image pulls, secrets
  └─ Wad Creator, served on 127.0.0.1:8081 (temporary, see below)
podman: wad-writing, wad-kale-b, …  each on 127.0.0.1:31x0 → container :3000
```

## Workspaces

| Hotkey | Workspace | Port | Image |
|---|---|---|---|
| Super+1 | Writing | 3100 | `ghcr.io/hunggod/wadspaces-writing` |
| Super+2 | IntelligenceQuest Dev | 3110 | `ghcr.io/hunggod/wadspaces-iq-dev` |
| Super+3 | Wad Creator Dev | 3120 | `ghcr.io/hunggod/wadspaces-wad-c` |
| Super+4 | Kale Browser | 3130 | `ghcr.io/hunggod/wadspaces-kale-b` |
| Super+5 | Vanua Academy | 3140 | `ghcr.io/hunggod/wadspaces-vanua-academy` |
| Super+6 | Kale Phone | 3150 | `ghcr.io/hunggod/wadspaces-kale-p` |

Super+0 or Super+Space returns to the launcher. On the launcher, plain 1–9
also work.

The images are built from `WadSpaces/containers` (`containers/build.sh`). The
list lives in [`host/etc/wadspaces/workspaces.yaml`](host/etc/wadspaces/workspaces.yaml),
which is the single source of truth: `wadd gen-quadlets` turns it into
`/etc/containers/systemd/wad-<id>.container` units.

A workspace is started the first time you switch to it. The kiosk shows a
splash while the image is pulled, the container starts and the desktop
answers, then moves to the stream. Workspaces you have visited keep running
until stopped.

## Wad Creator: local for now

Wad Creator is served by `wadd` itself on `http://localhost:8081` from
`/usr/share/wadspaces/wadcreator` (built into the image by `host/build.sh`
from `../WadCreator`). It calls the API on `127.0.0.1:8080` directly. Its origin
is trusted by the API; any other page shown in the kiosk gets `403` on
mutating calls.

Later Wad Creator moves to wadcreator.com. The host has no inbound port, so it
will use `wadd/cloud.py` instead: enrol with a one-time code, then poll
Firestore for commands. To switch over, set `wadcreator.enabled: false` and add:

```yaml
cloud:
  project_id: <firebase project>
  functions_region: australia-southeast2
  api_key: <web api key>
launcher:
  wadcreator_url: https://wadcreator.com/
```

## API

All on `127.0.0.1:8080`. Interactive docs at `/api/docs`.

| Method | Path | |
|---|---|---|
| GET | `/api/health`, `/api/status` | liveness, what the kiosk shows |
| GET | `/api/workspaces[/<id>]` | enabled workspaces with runtime state |
| POST | `/api/workspaces/<id>/switch` | show it, starting it if needed |
| POST | `/api/workspaces/<id>/start` \| `stop` \| `restart` | lifecycle without switching |
| POST | `/api/launcher` | back to the launcher |
| POST | `/api/navigate` `{url}` | localhost or allow-listed URLs only |
| GET | `/api/events` | server-sent events, a full snapshot on every change |
| GET | `/api/specs[/<id>]` | full specs, including disabled ones |
| POST | `/api/workspaces` | create (spec as JSON) |
| PUT / DELETE | `/api/workspaces/<id>` | replace / remove; running containers need a restart to pick up changes |
| GET | `/api/secrets` | podman secret names (values never leave podman) |
| PUT / DELETE | `/api/secrets/<name>` `{value}` | set / remove |

Create, update and delete validate the whole config, rewrite
`workspaces.yaml` (comments are not kept), regenerate the quadlets and run
`systemctl daemon-reload`.

## Building the OS

```bash
host/build.sh image     # localhost/wadspaces-host:latest; runs `bootc container lint`
host/build.sh qcow2     # + bootable disk in output/ (needs sudo)
host/build.sh iso       # + installer ISO for the Surface
```

The image enables RPM Fusion (free and nonfree) and installs the Intel VA-API
drivers (`intel-media-driver`, `libva-intel-driver`) and
`mesa-va-drivers-freeworld`, so the kiosk decodes the workspace streams in
hardware. Check on the device with `vainfo`.

Put your SSH key in `host/bib-config.toml` first; it creates an `admin` user
for debugging. The kiosk itself runs as `wad` with no password (greetd starts
it directly).

Try it in a VM:

```bash
sudo virt-install --import --name wadspaces --memory 6144 --vcpus 4 \
  --disk output/qcow2/disk.qcow2 --os-variant fedora-unknown --graphics spice
```

First boot on a new machine:

```bash
ssh admin@<host>
printf '%s' '<fine-grained PAT>' | sudo wadd secret set github_token
sudo podman login ghcr.io          # unless the workspace images are public
wadd status
```

Updates: push the image to `ghcr.io/hunggod/wadspaces-host`, then
`sudo bootc switch ghcr.io/hunggod/wadspaces-host:latest` once; after that
`bootc upgrade` (or the default timer) picks up new builds.

## Developing without the OS image

```bash
sudo dnf install python3-fastapi python3-uvicorn python3-websockets python3-evdev
cd ../containers/kale-b && ../build.sh --only kale-b && podman-compose up --no-start
cd - && dev/run-dev.sh            # or --kiosk
```

`--dev` drives the containers podman-compose created (`wad-<id>`) over the
user podman socket instead of systemd. Hotkeys need `/dev/input` access
(`sudo usermod -aG input $USER`, then log in again).

Tests: `python3 -m pytest tests`.

## Files

| Path | What |
|---|---|
| `wadd/manager.py` | switch/start/stop orchestration, CRUD, reconciliation with podman |
| `wadd/api.py` | HTTP API, launcher pages, the local Wad Creator server |
| `wadd/kiosk.py` | CDP client that moves the kiosk |
| `wadd/hotkeys.py` | evdev chord listener |
| `wadd/quadlet.py` | `.container` unit renderer (must match Wad Creator's) |
| `wadd/cloud.py` | Firestore relay for the hosted Wad Creator (not enabled yet) |
| `host/Containerfile` | the bootc image |
| `host/usr/libexec/wadspaces/` | kiosk session and Chromium command line |

## Troubleshooting

- **Hotkeys do nothing**: `journalctl -u wadd | grep hotkey` should list the
  keyboards. The launcher shows "hotkeys unavailable" when none were found.
- **A workspace fails to start**: the splash shows the error;
  `journalctl -u wad-<id>` has podman's side. On SELinux errors check
  `ausearch -m avc -ts recent` before changing policy; named volumes need `:z`.
- **Kiosk is blank**: Ctrl+Alt+F2 for a console, `journalctl -u greetd`.
- **If evdev hotkeys ever misbehave**: swap cage for sway in a kiosk config with
  `bindsym Mod4+1 exec curl -XPOST 127.0.0.1:8080/api/workspaces/writing/switch`.
  The API stays the same.
