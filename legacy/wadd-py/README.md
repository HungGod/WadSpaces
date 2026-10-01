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

The images are built from `../Wadspaces-David` (`Wadspaces-David/build.sh`), or by Wad Creator's Build (`/api/builds`). The
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

## Projects

A project is a folder of work kept apart from the images. A workspace mounts any number of them read-write at `~/Desktop/<mountName>`, so edits live on the host, survive the container, and one image runs with whichever projects you pick. Images no longer clone repos at start. A project is one of:

- **A GitHub repo** (`source: {kind: "git", url: "https://github.com/<owner>/<repo>[.git]", ref?}`). GitHub is where its files live. Each machine has its own copy at `/var/lib/wadspaces-projects/<id>`, owned by uid 1000 (the kiosk user `wad`, and `abc` in the images), and you move work between machines with ordinary commit, push and pull. Syncthing is gone.
- **A folder** on one machine (`{kind: "folder", machineId, machineName, path}`). wadd fills in `machineId` (the enrolled machine's id, or `local` until it is enrolled; the relay claims those on its next sync) and `machineName`, and stores the real path with symlinks resolved. The path must be an existing directory strictly inside one of `daemon.folder_roots` (by default `/var/home`, `/home`, `/mnt`, `/media`, `/run/media`, `/run/wadspaces-drives`), without `:` or `%`.
- **A drive** (`{kind: "drive", uuid, label, fstype, subpath}`): a folder on a filesystem known by its UUID, so it works on whichever machine the drive is plugged into. `subpath` is relative to the drive's root (`""` is the root) and can't use `..`.

The rest:

- **The document** lives in `<state_dir>/projects/<id>.json`, the same shape as Wad Creator's `users/{uid}/projects/{id}` in Firestore: `name`, `mountName`, `source`, `setup` (run once in the container, again when it changes), `deleted`, `createdAt`/`updatedAt` (epoch ms here), plus the local `synced`. Ids are 20 letters and digits, like Firestore's. `PUT`/`POST` with any other source is refused (422, "a project is a GitHub repo, a folder or a drive").
- **Older documents** (source `empty` or `local`, or a git URL that isn't GitHub) still load, marked `legacy: true`. They launch only while their folder is on the machine ("not a GitHub repo and not on this machine" otherwise), and are never pushed to the cloud. The old Syncthing fields (`holders`, `ignore`, `folderId`) are dropped wherever they turn up, including from the cloud's copy when this machine next writes one.
- **Deleting** leaves a tombstone (`deleted: true`) so the deletion syncs. A GitHub project's folder stays unless you purge it (`?purge=1`), which is refused while a workspace still mounts it. A purge never touches a folder or drive project's own folder.
- **Sync:** once the machine is linked, the relay syncs projects with Firestore every fourth heartbeat (2 min), soon after a local change, and on a `projects-sync` command. The newer `updatedAt` wins. Machines never delete a project document. A document the rules refuse doesn't hold up the rest.

**GitHub.** `wadd/github.py` uses the GitHub REST API with the `github_token` secret (the one the workspaces push with):

- `GET /api/github` says whether there is a token and whose it is.
- `GET /api/github/repos` lists the repos you own, collaborate on or reach through an organisation, most recently pushed first. It follows every page and keeps the list for 60 s.
- `POST /api/github/repos` creates a repo (private unless you say otherwise, with a first commit so it clones straight away), then the project for it.
- The online app has no token, so the relay writes the same list to `users/{uid}/github/repos` (`{login, repos, updatedAt}`). It checks every 20th heartbeat (10 min), on `projects-sync`, and soon after a repo is made here, and only writes when the list changed. Without a token it says nothing.

**Drives and folders.** `GET /api/drives` lists the filesystems a drive project could be on, from `lsblk`. It leaves out the disk the system runs from (whatever holds `/`, `/sysroot`, `/boot`, `/var` or `/etc`), swap, and LUKS/LVM members. `GET /api/fs/browse` is the folder picker: the folders (not hidden ones, at most 500) in a path inside `folder_roots`, or inside a drive with `drive=<uuid>`, mounting it first if it isn't mounted. A drive is mounted by `systemd-mount` at `/run/wadspaces-drives/<uuid>` when wadd runs as root, so PID 1 mounts it in the host's namespace: wadd's own namespace (`ProtectSystem=strict`) would hide a plain `mount` from podman. When wadd runs as a user (a laptop), `udisksctl mount` does it. FAT, exFAT and NTFS are mounted as uid 1000.

**A launch** (`POST /api/launches`) is a job, like a build:

1. At once (`asyncio.gather`):
   - **The image** must be on the machine. A `localhost/` image is never pulled ("build it in Wad Creator first"), and a registry image is pulled with the usual progress. With projects, the image must also carry `LABEL io.wadspaces.projects=1`. Images built on an older base clone their repos over `~/Desktop` at every start, so they are refused ("this image was built on an older base; rebuild it to use projects").
   - **Each GitHub project's folder**:
     - **Already there:** wadd runs `git fetch` (as uid 1000, with a 60 s limit). It then fast-forwards (`git merge --ff-only @{u}`) only when the working tree is clean (`git status --porcelain` is empty, so untracked files count), an upstream is set, and nothing is unpushed. Otherwise it leaves the folder alone and says why in the log: "Notes has uncommitted changes; not updated", "Notes has 2 unpushed commits; not updated", "Notes has no upstream branch; not updated", or "Notes is up to date". The project's line says the outcome, e.g. "updated (3 new commits)". If the fetch fails, the launch carries on with a warning.
     - **Not there:** the copy an older image cloned into the workspace's `/config` volume (`Desktop/<mount>`) is moved over with any uncommitted work. Otherwise wadd runs a `git clone` (as uid 1000, into `<id>.part`, then renamed). If the clone fails, the launch fails.

     For github.com, the `github_token` secret reaches git through a credential helper that reads it from the environment and answers only for `https://github.com`. The token is never on a command line.
   - **A folder project** must be this machine's ("Notes is a folder on Desk PC" otherwise) and there ("folder … is missing").
   - **A drive project** must be plugged in ("plug in the drive STICK"). wadd mounts the drive if it isn't mounted, and the folder must be there.

     wadd never fetches or otherwise touches a folder or drive project, even if it has a `.git`.

   New project folders get the SELinux type `container_file_t`.
2. wadd writes `<state_dir>/extra/<ws>/projects.json` (mounted read-only at `/run/wadspaces-extra`; the image's `wadspaces-projects` reads it) and sets the workspace's `projects: [{id, mount, path?}]`. `path` is the host folder of a folder or drive project. That rewrites `workspaces.yaml` and the quadlet:
   ```
   Volume=/var/lib/wadspaces-projects/<id>:/config/Desktop/<mount>:rw,z      # a GitHub project
   Volume=/var/home/wad/Notes:/config/Desktop/<mount>:rw                     # a folder or drive: no :z
   Volume=/var/lib/wadspaces/extra/<ws>:/run/wadspaces-extra:ro,z
   SecurityLabelDisable=true                                                 # with a folder or drive project
   ```
   Relabelling someone's home folder or a whole drive for containers would be harmful, so those mounts have no `:z` and the container runs unlabelled instead, like a native workspace. Then the workspace comes up and goes on screen, as with a switch. If it is running with a different set of projects, the launch needs `restart: true`; without it, the launch is refused with 409 (the UI asks first).

One launch runs per workspace at a time, and different workspaces launch in parallel. Progress goes out as `launch` events. Projects need the systemd backend, because the podman (dev) backend can't add mounts. Run history (`/api/runs`) records each run's project ids.

**Status** (`GET /api/projects/<id>/status`) is quick: no fetch and no mounting. It returns `{exists_on_disk, path, bytes: null, mounted_in, git, available, reason?}`.
- `git` is `{branch, dirty, ahead, behind, upstream}`, read from the refs already on the machine, for any project whose folder has a `.git`. It is `null` otherwise. Without an upstream, `ahead` and `behind` are 0 and `upstream` is `null`.
- `available` says whether a launch could use the project here. When it can't, `reason` says why, e.g. "on Desk PC" or "plug in the drive STICK".

**Between machines**, each machine's heartbeat publishes `mountedProjects` (the projects its running workspaces mount). A launch reads the owner's other machines first and, when a project is open on one that is online, logs "⚠ <mount> is open on <machine>: stop it there first to avoid conflicts". That is a warning, not a refusal.

## Tailscale

Tailscale is the trusted network between your machines. The host image installs `tailscale` from Tailscale's Fedora repo and enables `tailscaled`, which keeps its state in `/var/lib/tailscale` (bootc keeps `/var` across updates). `wadd/tailnet.py` reads status through tailscaled's LocalAPI socket (`daemon.tailscale_socket`) and makes changes with the `tailscale` CLI (`daemon.tailscale_bin`). On a machine without tailscaled, such as a dev laptop, the status is `{"installed": false}` and nothing else changes.

- **Joining**, either way:
  - `POST /api/tailnet/login` starts `tailscale login` and returns its URL, for the Manager to show as a link or QR code. The CLI keeps waiting in the background until you finish in the browser.
  - A `tailscale_authkey` secret in Wad Creator. `sync-secrets` doesn't copy it into podman; if the machine isn't logged in yet, wadd runs `tailscale up --auth-key=file:<0600 temp file>`. The key never appears on a command line.
- **Streams**: with `daemon.tailnet_streams` on (the default), each running stream workspace is served on the tailnet with `tailscale serve --bg --https=<port> http://127.0.0.1:<port>`, and unserved when it stops. Funnel is never used, so the links only open on your tailnet's devices. wadd checks every 15 s and straight away when a container starts or stops. It only touches serve entries that proxy a workspace's port to itself, so ones you set up by hand stay.
- **Heartbeat**: the machine document gets `tailnet: {online, ip, dnsName, stableId}` (left out without Tailscale) and `streams: [{wsId, url}]`, with url `https://<dnsName>:<port>/`.
- Status changes go out as `tailnet` events on `/api/events`.
- `whois` (which node and user is behind a tailnet address) is there for the peer API in Phase 7.

Set these up once in the Tailscale admin console: MagicDNS, HTTPS certificates (which `serve --https` needs), and an ACL that only lets your own devices in.

## Wad Creator

Two products, from `../WadCreator` (see its README):

- **The desktop app** (offline). It's built into the image at `/usr/lib/wadcreator` by `host/build.sh`.
  - Home's **Wad Creator** link calls `POST /api/apps/wadcreator/open`, and wadd starts the app in the kiosk's sway session through sway IPC `exec`.
  - wadd recognises its window by its executable and shows it as the view `app:wadcreator`, a window of its own like a native workspace. Closing it goes back Home.
  - The app calls this API directly from the origin `app://wadcreator`, which the API trusts. Any other page gets `403` on mutating calls.
  - It's blocked during focus time, like Home.
- **The web app** (online) reaches the machine through `wadd/cloud.py`.
  - The cloud relay is on, and idle until the machine is linked (Home → **Link this machine to Wad Creator**, with a code from the web app's Machines page). The project comes from `/usr/lib/wadspaces/cloud.yaml` (`host/usr/lib/wadspaces/cloud.yaml`), which wins over any `cloud:` section in `workspaces.yaml`: bootc keeps a locally changed `/etc` file on update, and wadd rewrites that file, so the project has to live in `/usr`.
  - Once linked, wadd heartbeats to Firestore every 30 s and runs the `switch/start/stop/restart` (and `sync-secrets`, `projects-sync`) commands queued there. The host needs no inbound port. It also keeps `users/{uid}/github/repos` current for the online app (see Projects).

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
| POST | `/api/builds` `{workspace, base_image?}` | Wad Creator's Build: a build job for a workspace spec (checked first). The base image must already be on the machine (see `--bases` below) |
| PUT | `/api/builds/<id>/context` | the build folder as a tar; podman builds `localhost/wadspaces-<id>:latest`, then the workspace is added or updated |
| GET / DELETE | `/api/builds[/<id>]` `?since=` | jobs, one job's log from a line on / cancel. Progress also goes out as `build` events |
| GET / PUT / DELETE | `/api/library/<wadspaces\|drafts>[/<id>]` | Wad Creator's designs and drafts, kept in `<state_dir>/library` |
| GET | `/api/projects` `?deleted=1` | projects (with tombstones) |
| POST | `/api/projects` | create one, with a new id |
| GET / PUT | `/api/projects/<id>` | one project / create or update it (`name`, `mountName`, `source`, `setup`; wadd sets the rest). The source is a GitHub repo, a folder or a drive (422 otherwise). The folder name must be unique (409) |
| DELETE | `/api/projects/<id>` `?purge=1` | tombstone it; purge also removes its folder (409 while a workspace mounts it) |
| GET | `/api/projects/<id>/status` | `{exists_on_disk, path, bytes, mounted_in, git, available, reason?}`; `git` is `{branch, dirty, ahead, behind, upstream}` or `null` |
| GET | `/api/github` | `{token, login}` (and `error` when the token is refused or GitHub can't be reached) |
| GET | `/api/github/repos` | `{login, repos: [{fullName, name, private, url, defaultBranch, pushedAt, description}]}`; 409 without a token, 502 when GitHub fails |
| POST | `/api/github/repos` `{name, private?, description?, mountName?, setup?}` | create a repo on GitHub (private by default), then its project; returns the project (201) |
| GET | `/api/drives` | `[{uuid, label, fstype, size, mountpoint, removable, model}]`: drives a project could be on |
| GET | `/api/fs/browse` `?path=` \| `?drive=<uuid>&path=` | `{path, parent, dirs: [{name, path}]}`: folders inside `folder_roots` (403 outside), or inside a drive (mounted first; paths relative to it) |
| POST | `/api/launches` `{workspace, projects, view?, restart?}` | launch a workspace with these projects (see Projects); 409 if it's running with others and `restart` isn't set |
| GET / DELETE | `/api/launches[/<id>]` `?since=` | jobs, one job's log from a line on / cancel. Progress also goes out as `launch` events |
| GET | `/api/metrics` | CPU, memory, disk and GPU for the Manager |
| GET | `/api/runs` `?workspace=&limit=` | when each workspace ran (`<state_dir>/runs.jsonl`) |
| GET | `/api/secrets` | podman secret names (values never leave podman) |
| PUT / DELETE | `/api/secrets/<name>` `{value}` | set / remove |
| GET | `/api/tailnet` | `{installed, running, backendState, online, loggedIn, ip, dnsName, stableId, hostName, loginName, streams}`; just `{installed: false, streams: []}` without Tailscale |
| POST | `/api/tailnet/login` | `{url, online}`: the login URL to open (`null` when already on the tailnet); 404 without Tailscale |
| POST | `/api/tailnet/logout` | leave the tailnet |
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
# ...and the base images the machine's own builds start from
host/build.sh update /dev/sdX --bases
```

`install` refuses the disk that holds `/` and asks you to type the device path
before erasing anything. Find the drive with `lsblk -o NAME,SIZE,MODEL,TRAN`.
Boot the Surface from it with Volume-down held while pressing Power.

**`update`** is the fast path once a drive is installed:
- It writes the host image, the `--images` and, with `--bases`, the base images into an OCI directory whose layers are uncompressed, so a layer's file name is its content. It then `rsync`s that to the drive's `/var/lib/wadspaces/incoming`, so only changed layers are written. A change to wadd's code is a few MB, where a full image is several GB.
- At the next boot, `wadspaces-import.service` (`/usr/libexec/wadspaces/import-updates`) runs before the kiosk:
  1. it imports the workspace images into podman storage, under the names in `workspaces.yaml`, so they never download, and the bases as `localhost/wadspaces-{base,stream,selkies}:trixie`;
  2. if the host image changed, it runs `bootc switch` to it and restarts once.
- `--images` and `--bases` also work with `install`.
- Bases are never downloaded: a build on the machine (`/api/builds`) fails with "update the drive with `host/build.sh update --bases`" when its base isn't there.
- `--stage-only DIR` writes into a directory instead of a drive, for testing.

The import service only exists in images from 2026-09-26 on; a drive installed before that needs one `install` first.

### Baked-in secrets

`host/secrets/` is gitignored and kept out of the build context by
`.containerignore`. `build.sh` copies only these into the image:

| Source | In the image | Used as |
|---|---|---|
| `host/secrets/github_auth.json` (`{"github_pat": "..."}`) | `/usr/lib/wadspaces/secrets/podman/github_token` | podman secret `github_token` (git push in workspaces) |
| `host/secrets/admin_password_hash`, else the hash in `bib-config.toml` | `/usr/lib/wadspaces/secrets/admin_password_hash` | `admin`'s password, set by `wadspaces-admin-password.service` when admin has none and again whenever this hash changes (make one with `openssl passwd -6 > host/secrets/admin_password_hash`) |
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
cd ../Wadspaces-David/kale-b && ../build.sh --only kale-b && podman-compose up --no-start
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
| `wadd/cloud.py` | Firestore relay for the hosted Wad Creator: heartbeat, commands, projects sync, sibling machines |
| `wadd/projects.py` | project documents, their folders on disk, `projects.json` |
| `wadd/launches.py` | launch jobs: image + project folders at once, then start with the mounts |
| `wadd/gitimport.py` | host-side git for GitHub projects: clone, status, fetch and fast-forward |
| `wadd/github.py` | GitHub REST client: login, repo list, creating repos |
| `wadd/drives.py` | drives (`lsblk`, mounting) and folders inside `folder_roots` for folder and drive projects |
| `wadd/tailnet.py` | Tailscale: LocalAPI status and whois, login, serving stream workspaces |
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
