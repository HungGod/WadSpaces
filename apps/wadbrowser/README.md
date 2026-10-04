# WadBrowser

The web browser in every WadSpaces workspace (formerly KaleBrowser, an
Electron app). It's three things in one program:

- **WadBrowser**: a browser with tabs and an address bar;
- **WadBrowser Focus**: tabs, no address bar; pages arrive by links;
- **every web app's window** (`wadspaces-webapp`): one site, its own name,
  icon and window class (`wadspaces-webapp-<id>`), no address bar.

Links from other apps (`xdg-open`) open in whichever of the first two the
workspace's design has on its desktop (`/etc/wadspaces/wadbrowser.conf`).

## How it's put together

Tauri 2 on WebKitGTK 4.1. Tauri owns each window and its one webview, the
chrome (`ui/`: plain HTML, CSS and JS, embedded in the binary). The pages
are WebKitGTK views WadBrowser makes itself, in a stack under the chrome:
Tauri's own child webviews can't be laid out on Wayland, and pages never get
Tauri's IPC this way. Menus and panels are a transparent view in a popup
surface of their own, which the compositor blends over the page.

- **One process per user** (`ipc.rs`): a later launch hands its request to
  the running browser over `$XDG_RUNTIME_DIR/wadbrowser/ctl.sock` and exits,
  so a link opens in the window already there and tabs move between windows
  live (drag one off the strip, or onto another window's).
- **Memory**: one shared profile (one network process and cache for every
  web app); tabs idle for 15 minutes sleep (their history kept) and wake
  where they were; WebKit sheds caches under memory pressure.
- **GPU**: on when the container has a usable `/dev/dri` (`gpu.rs`), video
  decoded with VA-API.
- **What WebKitGTK can't do**: DRM (EME) and video calls (WebRTC). Spotify,
  Discord, Zoom and Slack are Chrome web apps in Wad Creator for that reason.

## Command line

```
wadbrowser [URL...]                       a browser window
wadbrowser --no-urlbar [URL...]           WadBrowser Focus
wadbrowser --default [URL...]             what the workspace chose (links)
wadbrowser --app <id> --name <name> --url <start> [URL...]
  --new-window  --profile <p>  --gpu auto|on|off  --icon <png>  --config <kalebrowser.json>
```

Settings: `/etc/wadspaces/wadbrowser.conf`, then
`~/.config/wadbrowser/wadbrowser.conf` (`default`, `home`, `search`,
`hibernate_after_minutes`, `gpu`). `WADBROWSER_DEVTOOLS=1` adds the inspector
(F12); `WADBROWSER_LOG=debug` says more.

## Building and trying it

- `cargo build -p wadbrowser` builds it for this laptop (Fedora's WebKitGTK).
- `images/build.sh --only base` builds it for workspaces, in a Debian trixie
  container (`images/builder/`), and bakes it into the base image.
- `spike/run.sh` runs a scripted session on a headless sway (screenshots of
  its windows, tabs moved between windows, a tab put to sleep and woken, a
  download, find in page): `cargo build -p wadbrowser --features spike` first.
  `WADBROWSER_SPIKE_SITES="https://… …"` checks real sites and what WebKit
  supports.
- `spike/ipc.sh` checks the hand-off from a second launch, timed.
- `apps/wadd/dev/try-build.sh` builds a design with web apps through wadd and
  opens one, and a link, in a real workspace.

The icon is the light WadSpaces mark (`icons/`, from
`apps/wadcreator/public/brand/wadspaces-icon-light-transparent.svg`).
