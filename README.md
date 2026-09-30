# Workspace-Switcher

The host side of WadSpaces: a bootable Fedora image that boots straight into a
fullscreen kiosk, and `wadd`, the daemon that switches the screen between
isolated workspace containers.

```
greetd ─► sway (etc/sway/wadspaces.conf, no key bindings)
            ├─ workspace "shell": chromium --kiosk http://127.0.0.1:8080/
            │    └─ shell page: Home (the focus flow), one frame per streamed
            │       workspace, Super+Tab carousel, Wi-Fi + power menus
            └─ workspace "ws-<id>": a native workspace's own desktop window
wadd (root, 127.0.0.1:8080)
  ├─ REST + server-sent events  /api/*   (the shell follows wadd's view)
  ├─ keyboard proxy: grabs /dev/input keyboards, re-emits via uinput,
  │    keeps Super+Tab / Super+1..9 / Super+0, drops Alt+F4 & co.
  ├─ systemctl start wad-<id>.service   (podman quadlets, not auto-started)
  ├─ sway IPC (/run/user/1000/sway-ipc.*.sock): brings native windows forward
  ├─ podman REST socket: state, image pulls, secrets, logs
  ├─ nmcli: the Wi-Fi menu;  systemctl poweroff/reboot: the power menu
  ├─ starts the Wad Creator desktop app in the kiosk session (see below)
  └─ cloud relay: heartbeat + commands for the online Wad Creator, once linked
podman: wad-writing, wad-iq-dev  native: draw on sway via /run/user/1000
        wad-kale-b, …           streamed: 127.0.0.1:31x0 → container :3000
```

## Workspaces

| Hotkey | Workspace | Display | Image |
|---|---|---|---|
| Super+1 | Writing | native | `ghcr.io/hunggod/wadspaces-cosmic-bodybuilding` |
| Super+2 | IntelligenceQuest Dev | native | `ghcr.io/hunggod/wadspaces-iq-dev` |
| Super+3 | Wad Creator Dev | stream, 3120 | `ghcr.io/hunggod/wadspaces-wad-c` |
| Super+4 | Kale Browser | stream, 3130 | `ghcr.io/hunggod/wadspaces-kale-b` |
| Super+5 | Vanua Academy | stream, 3140 | `ghcr.io/hunggod/wadspaces-vanua-academy` |
| Super+6 | Kale Phone | stream, 3150 | `ghcr.io/hunggod/wadspaces-kale-p` |

**Two kinds of workspace** (`display:` in `workspaces.yaml`):

- `display: host` (native): a lean image from `containers/_common`. Its desktop
  is its own window on this screen, so there is no stream and no input lag. The
  quadlet mounts the kiosk session's runtime dir (`/run/user/1000`, the `wad`
  user is pinned to uid 1000) at `/run/wadspaces-display` with SELinux
  labelling off, and publishes no port. sway assigns every new non-Chromium
  window to a hidden `pending` workspace. wadd works out which container drew
  it (from the process's cgroup), moves it to `ws-<id>`, and focuses it when
  you switch there. A native workspace is ready when its window appears. The
  same image runs remotely next to a stream sidecar (see `containers/README.md`).
- `display: stream` (default): an all-in-one Selkies image streamed into a
  frame of the shell on `127.0.0.1:<port>`.

**Home is a short flow.**

1. "What workspace(s) do you want to work on right now?" Pick one or more; Super+Tab lists them in the order picked.
2. **Continue** starts their downloads straight away, several at once. Images copied onto the drive with `host/build.sh --images` are already there, so Wi-Fi is optional.
3. "How long do you want to work for?" Use the clock dial (drag the hand, one lap = an hour) or pick 25 / 50 / 90 min, while download bars show above it. Then **Start focus** or **Skip focus mode**.
4. Home becomes the landing page, "What others are working on": a grid of shared streams, sample data for now. Above it are your picks: each opens as soon as it's ready, even while others still download.

Before anything is picked, Super+Tab holds only Home. In a session it holds only your picks:

- **Focus.**
  - The clock starts the first time one of your picks is on screen, not when you press Start.
  - Until the time is up, Home and Wad Creator are out of reach (`/api/launcher`, `/api/navigate` and `/api/apps/wadcreator/open` answer 409). The HUD shows the time left, and there's no early exit apart from the power menu.
  - When the time is up, Home joins Super+Tab.
- **Skipped focus:** no timer, and Home is always in Super+Tab.

Home's **New session** (when not in focus time) goes back to picking. A session survives a reboot (`/var/lib/wadspaces/session.json`).

**The Wi-Fi, power and timer buttons float above everything.** The sway session runs `hud`, a small GTK4 layer-shell overlay anchored bottom-right, so they stay visible over native workspace windows too. A click brings the shell forward with that menu open, and closing it goes back. Outside the kiosk (dev), the shell page draws them itself.

**Super+Tab** opens the switcher over whatever is on screen: keep holding
Super, press Tab to move (Shift+Tab back), let go of Super to switch, Esc to
cancel. It starts on the view you were on before, like Alt+Tab. Over a native
window, wadd brings the shell forward to draw the switcher, and puts the window
back on commit or cancel. Super+1–9 jump straight to a workspace and Super+0 or
Super+Space go Home (outside a session). On Home, plain 1–9 toggle a pick.

wadd grabs the keyboards and passes everything else on through a virtual
keyboard (`wadspaces-kbd`), so Super never reaches a workspace and the chords
in `daemon.keys.block` (Alt+F4, Ctrl+Shift+Q, Ctrl+Alt+Backspace) never reach
anything. Modifiers must match exactly, so Ctrl+Alt+F2 still opens a console.
If wadd dies, the kernel releases the keyboards.

The images are built from `WadSpaces/containers` (`containers/build.sh`). The
list lives in [`host/etc/wadspaces/workspaces.yaml`](host/etc/wadspaces/workspaces.yaml),
which is the single source of truth: `wadd gen-quadlets` turns it into
`/etc/containers/systemd/wad-<id>.container` units.

Images are downloaded as soon as they're picked on Home (or on the first
switch), up to `daemon.max_parallel_pulls` (3) at once, each with a progress
bar. Podman's API reports no byte counts, so wadd:

- reads the layer sizes from the registry, leaving out layers it already has;
- counts bytes arriving on the network interfaces;
- splits those bytes between the downloads in progress, by how much each still needs.

Switching is instant for a running workspace: a native one is just focused, and
the shell keeps each streamed one in its own frame and just shows it (the `shell.live_frames` most recent stay loaded;
older ones reconnect in about a second). Switching to a stopped one keeps you
where you are with a progress toast, then swaps once its desktop answers.
Workspaces you have visited keep running until stopped.

## Wad Creator

Two products, from `../WadCreator` (see its README):

- **The desktop app** (offline). It's built into the image at `/usr/lib/wadcreator` by `host/build.sh`.
  - Home's **Wad Creator** link calls `POST /api/apps/wadcreator/open`, and wadd starts the app in the kiosk's sway session through sway IPC `exec`.
  - wadd recognises its window by its executable and shows it as the view `app:wadcreator`, a window of its own like a native workspace. Closing it goes back Home.
  - The app calls this API directly from the origin `app://wadcreator`, which the API trusts. Any other page gets `403` on mutating calls.
  - It's blocked during focus time, like Home.
- **The web app** (online) reaches the machine through `wadd/cloud.py`.
  - The `cloud:` section in `workspaces.yaml` is on, and idle until the machine is linked (Home → **Link this machine to Wad Creator**, with a code from the web app's Machines page).
  - Once linked, wadd heartbeats to Firestore every 30 s and runs the `switch/start/stop/restart` commands queued there. The host needs no inbound port.

The old in-kiosk web copy (`wadcreator:` section, :8081) is off; it stays for development in a browser.

## API

All on `127.0.0.1:8080`. Interactive docs at `/api/docs`.

| Method | Path | |
|---|---|---|
| GET | `/api/health`, `/api/status` | liveness, what the kiosk shows |
| GET | `/api/workspaces[/<id>]` | enabled workspaces with runtime state |
| POST | `/api/workspaces/<id>/switch` | show it, starting it if needed |
| POST | `/api/workspaces/<id>/start` \| `stop` \| `restart` \| `download` | lifecycle without switching |
| POST | `/api/session` `{workspaces, minutes?}` | start a session: the picks start and Home shows the landing page; without `minutes` focus is skipped (409 during focus time) |
| POST | `/api/session/end` | Home's "New session", back to picking (409 during focus time) |
| POST | `/api/apps/wadcreator/open` | show the Wad Creator desktop app, starting it if needed |
| POST | `/api/hud` `{panel}`, `/api/hud/closed` | the floating HUD: open `wifi`/`power` in the shell, then put the view back |
| POST | `/api/launcher` | go Home (409 during a session) |
| POST | `/api/navigate` `{url}` | show a localhost or allow-listed URL in the shell |
| POST | `/api/keys/action` `{action}` | what a shortcut would do: `launcher`, `switch:<id>`, `carousel_next` \| `prev` \| `commit` \| `cancel` |
| POST | `/api/power` `{action}` | `poweroff` \| `reboot` |
| GET | `/api/diagnostics` | podman, disk, network, kiosk, per-workspace state, recent warnings |
| GET | `/api/logs/daemon`, `/api/logs/unit/<unit>`, `/api/logs/workspace/<id>` `?lines=` | wadd's log, a unit's journal, a container's output |
| GET | `/api/events` | server-sent events, a full snapshot on every change |
| GET | `/api/specs[/<id>]` | full specs, including disabled ones |
| POST | `/api/workspaces` | create (spec as JSON) |
| PUT / DELETE | `/api/workspaces/<id>` | replace / remove; running containers need a restart to pick up changes |
| GET | `/api/secrets` | podman secret names (values never leave podman) |
| PUT / DELETE | `/api/secrets/<name>` `{value}` | set / remove |
| GET | `/api/network` | connection state, SSID, signal |
| GET | `/api/network/wifi` | scan: SSID, signal, security, saved/active |
| POST | `/api/network/wifi/connect` `{ssid, password?}` | join (saved networks need no password) |
| POST | `/api/network/wifi/disconnect`, `/forget` `{ssid}` | |

Everything the diagnostics and log endpoints return has GitHub tokens,
`Authorization` headers and passwords redacted, since it gets pasted around.
Wad Creator's **Diagnostics** tab shows all of it, with a Copy report button.

Create, update and delete validate the whole config, rewrite
`workspaces.yaml` (comments are not kept), regenerate the quadlets and run
`systemctl daemon-reload`.

## Building the OS

```bash
host/build.sh image              # localhost/wadspaces-host:latest; runs `bootc container lint`
host/build.sh qcow2              # + bootable disk in output/ (needs sudo)
host/build.sh iso                # + installer ISO
host/build.sh install /dev/sdX   # + `bootc install to-disk` onto a USB drive (wipes it)
host/build.sh update /dev/sdX    # + copy onto an installed drive in place (keeps its data)

# with install/update: also put locally built workspace images on the drive
host/build.sh update /dev/sdX --images writing,iq-dev
```

`install` refuses the disk that holds `/` and asks you to type the device path
before erasing anything. Find the drive with `lsblk -o NAME,SIZE,MODEL,TRAN`.
Boot the Surface from it with Volume-down held while pressing Power.

**`update`** is the fast path once a drive is installed:
- It writes the host image and the `--images` into an OCI directory whose layers are uncompressed, so a layer's file name is its content. It then `rsync`s that to the drive's `/var/lib/wadspaces/incoming`, so only changed layers are written. A change to wadd's code is a few MB, where a full image is several GB.
- At the next boot, `wadspaces-import.service` (`/usr/libexec/wadspaces/import-updates`) runs before the kiosk:
  1. it imports the workspace images into podman storage, under the names in `workspaces.yaml`, so they never download;
  2. if the host image changed, it runs `bootc switch` to it and restarts once.
- `--images` also works with `install`.
- `--stage-only DIR` writes into a directory instead of a drive, for testing.

The import service only exists in images from 2026-09-26 on; a drive installed before that needs one `install` first.

### Baked-in secrets

`host/secrets/` is gitignored and kept out of the build context by
`.containerignore`. `build.sh` copies only these into the image:

| Source | In the image | Used as |
|---|---|---|
| `host/secrets/github_auth.json` (`{"github_pat": "..."}`) | `/usr/lib/wadspaces/secrets/podman/github_token` | podman secret `github_token` (git push in workspaces) |
| `host/secrets/admin_password_hash`, else the hash in `bib-config.toml` | `/usr/lib/wadspaces/secrets/admin_password_hash` | `admin`'s password, set once by `wadspaces-admin-password.service` |
| `$ADMIN_SSH_KEY`, else the key in `bib-config.toml` | `/usr/share/wadspaces/ssh/admin` | `admin`'s SSH key |

wadd creates each podman secret at startup when it is missing or the baked
file changed, so a new token in a new image takes effect, and a value set with
`wadd secret set` stays until then. Anyone with the image or the disk can read
these files; don't push the host image to a public registry.

### Downloads and autostart

Once the machine is online, wadd pulls and starts workspaces with
`autostart: true` (set it in Wad Creator's editor) first. The shipped config
has `daemon.prefetch: all`, so it then downloads every other image, skipping
any once less than `daemon.prefetch_min_free_gb` (5 here) would be left.
Skipped images download on first switch. The six images share a 2.8 GB base
and need about 20 GB in total. Set `prefetch: autostart` (the code default)
to download only the autostart ones.

The image enables RPM Fusion (free and nonfree) and installs the Intel VA-API
drivers (`intel-media-driver`, `libva-intel-driver`) and
`mesa-va-drivers-freeworld`, so the kiosk decodes the workspace streams in
hardware. Check on the device with `vainfo`.

Put your SSH key and a password hash (`openssl passwd -6`) in
`host/bib-config.toml` first; they become the `admin` user for debugging. The kiosk itself runs as `wad` with no password (greetd starts
it directly).

Try it in a VM:

```bash
sudo virt-install --import --name wadspaces --memory 6144 --vcpus 4 \
  --disk output/qcow2/disk.qcow2 --os-variant fedora-unknown --graphics spice
```

First boot on a new machine: Home opens its Wi-Fi menu (bottom right) if
there is no connection. After that, `ssh admin@<host>` and `wadd status`.

Updates: the host image stays local (it contains the baked secrets), so copy a
new build over and switch to it:

```bash
host/build.sh image
podman save localhost/wadspaces-host:latest | ssh admin@<host> sudo podman load
ssh admin@<host> sudo bootc switch --transport containers-storage localhost/wadspaces-host:latest
```

## Developing without the OS image

```bash
sudo dnf install python3-fastapi python3-uvicorn python3-websockets python3-evdev
cd ../containers/kale-b && ../build.sh --only kale-b && podman-compose up --no-start
cd - && dev/run-dev.sh            # or --kiosk
```

`--dev` drives the containers podman-compose created (`wad-<id>`) over the
user podman socket instead of systemd, and only *watches* the keyboard (it
never grabs a dev machine's keyboard). That needs `/dev/input` access
(`sudo usermod -aG input $USER`, then log in again); without it, drive the
shortcuts with `POST /api/keys/action`.

Tests:

```bash
python3 -m venv .venv && .venv/bin/pip install fastapi uvicorn httpx pyyaml pytest websockets
.venv/bin/python -m pytest tests
```

## Files

| Path | What |
|---|---|
| `wadd/manager.py` | switch/start/stop orchestration, CRUD, reconciliation with podman |
| `wadd/api.py` | HTTP API, the shell page, the local Wad Creator server |
| `wadd/web/` | the shell: frames, Home's focus flow and dial, carousel, Wi-Fi and power menus |
| `wadd/display.py`, `wadd/sway.py` | native workspaces: sway IPC, window → container, focus |
| `wadd/kiosk.py` | CDP client that puts the kiosk back on the shell if it strays |
| `wadd/keyproxy.py` | keyboard grab + uinput re-emit, shortcut routing |
| `wadd/registry.py` | download progress: registry layer sizes, network byte counts |
| `wadd/logbuffer.py` | in-memory log for Diagnostics, token redaction |
| `wadd/network.py` | Wi-Fi menu backend (nmcli) |
| `wadd/quadlet.py` | `.container` unit renderer (must match Wad Creator's) |
| `wadd/cloud.py` | Firestore relay for the hosted Wad Creator (not enabled yet) |
| `host/Containerfile` | the bootc image |
| `host/usr/libexec/wadspaces/` | kiosk session and Chromium command line |
| `host/etc/sway/wadspaces.conf` | the kiosk compositor: shell workspace, pending windows, no bindings |
| `host/usr/libexec/wadspaces/hud` | Wi-Fi / power / focus-timer buttons above every window (GTK4 layer-shell) |
| `host/usr/libexec/wadspaces/import-updates` | imports what `host/build.sh update` copied onto the drive |

## Troubleshooting

- **Shortcuts do nothing**: `journalctl -u wadd | grep keyboard` should show
  "keyboard grabbed: /dev/input/eventN". Home shows "keyboard not
  captured" when none were found. "keyboard grab unavailable" means
  `/dev/uinput` couldn't be opened (is the `uinput` module loaded?).
- **Something is stuck or failing**: Wad Creator → Diagnostics shows each
  workspace's phase, download progress and last error, plus logs.
- **A workspace fails to start**: its tile and Diagnostics show the error;
  `journalctl -u wad-<id>` has podman's side. On SELinux errors check
  `ausearch -m avc -ts recent` before changing policy; named volumes need `:z`.
- **Kiosk is blank**: Ctrl+Alt+F2 for a console, `journalctl -u greetd`,
  `journalctl -b -t kiosk` (sway and Chromium output). "Profile in use by another
  Chromium process" was a stale lock after a forced power-off; `chromium-kiosk`
  now clears it on every start, and the hostname is fixed (`wadspaces`) so a
  DHCP-assigned name can't trip it.
- **Boot hangs with EIO / "lazy lowerdata lookup failed"**: the USB drive
  dropped off the bus (`journalctl -k` shows it re-appear as a new `sdX`). The
  image sets `usbcore.autosuspend=-1`; if it recurs, try the other USB port or
  another drive.
- **An update didn't apply**: `journalctl -b -u wadspaces-import`.
- **A native workspace never opens**: `podman logs wad-<id>` should show
  `[svc-de] drawing on /run/wadspaces-display/wayland-N`. `journalctl -u wadd |
  grep native` shows whether wadd saw its window. Diagnostics says "did not open
  a window" after `ready_timeout_s`.
- **If the keyboard grab ever misbehaves**: set `daemon.keys.grab: false` to go
  back to watching only (shortcuts still work, nothing is blocked), or add
  `bindsym Mod4+Tab exec curl -XPOST -d '{"action":"carousel_next"}'
  -H 'Content-Type: application/json' 127.0.0.1:8080/api/keys/action` to the
  sway config.
