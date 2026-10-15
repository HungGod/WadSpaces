# Native client: parity and the switch

The native WadSpaces Client (`apps/desktop`, GTK4) replaces the Tauri one
(`apps/client/src-tauri`) on the machine once it does everything the Tauri
one does. Until then the image carries both.

## Trying it on a machine

The image has `/usr/bin/client-native` beside `/usr/bin/client`.
`client-session` runs the native one when the kiosk user's
`~/.config/wadspaces/client` holds the line `native`. On the machine,
open the terminal (it runs as that user, `wad`):

```sh
echo native > ~/.config/wadspaces/client
pkill -x client           # or reboot: client-session starts it again, native
```

Back to the Tauri app:

```sh
rm ~/.config/wadspaces/client
pkill -x client-native    # or reboot
```

The file is read each time the client starts. Signing out of the account
doesn't restart it.

Its log is in the journal: `journalctl -b -t client`.

## What matches the web app

| Area | Web app | Native |
| --- | --- | --- |
| Setup | MachineGate: Wi-Fi, sign-in, Welcome (username), link, relink, GitHub | setup.rs, the `client-signin` window |
| Home | greeting, numbers, Jump back in, Running now, Your wadspaces, the tour | pages/home.rs |
| Launcher | pick, focus mode, customize a run, WadBrowser runs, saved setups (deleted with Undo) | launcher.rs, slots.rs |
| Activity | builds and launches, their logs | activity.rs |
| Focus | the banner and countdown; going back after a restart | focus.rs, chrome.rs |
| Machines | the list; Wadspaces, History, Storage, Files and Diagnostics tabs; other machines through their relay | pages/machines/ |
| A wadspace's details | WadspaceDrawer; the row menu's Details, Customize, Edit in Builder, New from it, Delete | details.rs |
| Secrets | saved sign-ins (make, rename, sign out, delete), tokens, GitHub | pages/secrets.rs, signins.rs |
| Builder | the board, drags, the three editors, Preview, Fix, Recently deleted (and for good), Undo, Build all, unsaved work kept | pages/builder/ |
| Tour, notices | Tour.tsx, ProfileNotices | tour.rs, notices.rs |
| Machine chrome | wadd's notices, "Starting …", the focus prompt | store.rs, chrome.rs |
| The HUD's room | `--hud-room` | `window.hud-room` (hud.json, watched) |

Two differences are deliberate:

- **Drags are in-app only.** As in the web app, nothing is dragged in from
  outside.
- **The key menu is a popover.** It renders as a separate surface, so
  snapshots don't show it.

## Not tried yet

These have only run in the headless snapshots (`dev/headless.sh`), against
the made-up machine in `fixtures/desktop/`:

- **Input:** real pointer drags (only scripted ones so far), touch on the
  Surface, and keyboard focus order.
- **Account writes:**
  - the Builder's saves;
  - Recently deleted's "for good";
  - restoring a wadspace;
  - deleting from the details drawer;
  - `set_onboarded`.
- **Data kept across a restart:** `builder.json` (Recently deleted, unsaved
  work) and the tour's step.
- **Copying in from the machine:** a folder or files, through `/v1/browse`
  and `/v1/copies`.
- **Sign-out:** signing out, then in as someone else (the board, tour and
  notices start afresh).

## The soak (1–2 days on the Surface)

Use it as the machine's shell for normal work. Then check:

- Super+Tab and the HUD over it; the HUD's bar out and tucked.
- A wadspace started from Home, from the launcher, and from a notice's Open.
- A build from the Builder's bucket; a template edited and saved.
- A focus session, and a restart in the middle of one.
- Memory: about 60 MB idle (80 MB with the Builder open), against the
  Tauri app's. In the headless harness on the laptop (KWin, nothing else
  sharing GTK), it's 62 MB for an empty account and 86 MB for the sample's
  two wadspaces, each with a picture wallpaper. On the Surface:
  `grep Pss /proc/$(pidof client-native)/smaps_rollup`. On a laptop:
  `dev/headless.sh measure [--tauri]`.
- 0% CPU while a wadspace is on screen.
- The renderer: `GSK_RENDERER=ngl`, `vulkan` and `cairo`, timed and watched
  for glitches.

## The switch

Once the soak is clean:

1. `client-session`: run the native client by default, and drop the switch.
2. `host/build.sh`: `stage_client` builds the native client (no npm, no
   Tauri); `stage_desktop` folds into it.
3. Containerfile: `/usr/bin/client` becomes the native binary; drop
   `client-native`; set `GSK_RENDERER` in `client-session` if the soak picked
   one.
4. Remove the Tauri app's WebKit data once. It lives in
   `~/.local/share/io.wadspaces.client/`: `CacheStorage`, `databases`,
   `hsts-storage.sqlite`, `localstorage`, `mediakeys`, `storage` and
   `WebKitCache`. The native client's `account/` folder is there too: keep
   it.
5. Take `apps/client/src-tauri` out of the workspace.

Before updating a machine, save any unsaved board edits: the Tauri app kept
them in WebKit's storage, which isn't carried over. `bootc rollback` goes
back.
