# WadSpaces

The software that runs a WadSpaces machine, and the Wad Creator app used to design and run wadspaces.

| Path | What it is |
|---|---|
| `apps/wadd/` | wadd, the machine daemon: workspaces, projects, builds, the account link, streams. Its API is `/v1` over `/run/wadd/wadd.sock`. |
| `apps/wadcreator/` | Wad Creator: the React UI. It's built for three targets (`src/lib/machine.ts`): the web portal (`online`, `wad-spaces.web.app`), the machine app (`machine`, inside Tauri: the kiosk's shell), and `offline` (development against a dev wadd). The Firebase function and Firestore rules are here too. |
| `apps/wadcreator/src-tauri/` | The machine app: Tauri around the same React UI. Its Rust side holds the commands the UI calls (`src/gen/bindings.ts` is generated from them). |
| `apps/hud/` | The HUD: the buttons above every wadspace, and the switcher, Wi-Fi and power overlays. |
| `crates/` | Shared Rust crates:<br>• `wad-proto`: types shared by wadd, the app and the UI<br>• `wad-core`: designs and generators; also compiled to wasm for the UI<br>• `wad-config`<br>• `wad-store`: wadd's state files<br>• `wad-podman`, `wad-systemd`, `wad-sway`<br>• `wad-input`: the keyboard proxy<br>• `wad-git`: project clones and fast-forwards<br>• `wad-net`: Wi-Fi through NetworkManager<br>• `wad-github`: device-flow sign-in<br>• `wad-firebase`: Firestore from Rust |
| `host/` | The machine's OS image (Fedora bootc, sway, Wad Creator as the shell), and `host/build.sh` to build it and write it to a drive. `CUTOVER.md` and `STREAMS.md` are the checklists for the cutover from the Python wadd and for streams. |
| `images/` | The images workspaces are made from: `base` (the lean desktop every design builds on) and `stream` (the sidecar a workspace draws on when it's viewed from another device). `images/build.sh` builds them. |
| `fixtures/` | What every renderer must reproduce:<br>• unit files (`quadlet/`)<br>• the core's goldens (`core/`)<br>• the hand-written workspaces from before the Builder (`presets/`)<br>• the old Python wadd's config cases (`python-state/`) |

## Tests

```bash
cargo xtask ci                                         # everything below except the rules tests
cargo test --workspace                                 # Rust
(cd apps/wadcreator && npm test && npm run typecheck)  # UI
(cd apps/wadcreator && npm run test:rules)             # Firestore rules (emulator)
```

After changing a Tauri command or a `wad-proto` type, run `cargo xtask bindings` (a test fails until you do). After changing `wad-core`, run `cargo xtask wasm`.

## The machine app

Try it on a laptop, in a window, without the host image. Run wadd as you, then the app; the app finds wadd's socket by itself.

```bash
cargo run -p wadd -- serve --user &
cd apps/wadcreator && npm run app      # hot reload
npm run build:app                      # release build at target/release/wadcreator (--kiosk for fullscreen)
```

You sign in with your real account (Firebase). Wi-Fi and Power in the app act on the laptop for real.

The Rust toolchain is pinned in `rust-toolchain.toml`. On Fedora the app also needs these packages:
- `webkit2gtk4.1-devel`, `javascriptcoregtk4.1-devel`, `libsoup3-devel`, `gtk3-devel`, `librsvg2-devel`;
- `binaryen`, for the wasm build;
- `gtk4-devel` and `gtk4-layer-shell-devel`, for the HUD.

## wadd on a laptop

`wadd serve --user` runs it as you, on a laptop:
- rootless podman and your systemd;
- a socket at `$XDG_RUNTIME_DIR/wadd/wadd.sock` (`curl --unix-socket … http://wadd/v1/states`).

The trial scripts use their own state under `.build/`, and need `systemctl --user start podman.socket`.

```bash
apps/wadd/dev/try.sh           # workspaces: cold and warm start, stop, restart, download progress
apps/wadd/dev/try-view.sh      # the screen: a headless sway with the machine's rules and a real lean
                               # workspace's window: switching, Super+Tab, focus sessions
apps/wadd/dev/try-projects.sh  # projects: a GitHub clone, a folder and a loop-device "stick",
                               # launched together into a workspace
apps/wadd/dev/try-build.sh     # builds: a design built on the lean base, installed, and opened
                               # in the headless sway
apps/wadd/dev/try-cloud.sh     # the account link, against the Firebase emulators (real rules and
                               # enrollMachine): link, heartbeat, commands, project and secret sync
apps/wadd/dev/try-github.sh    # GitHub for real: whose token podman has, and your repos
                               # (--sign-in: the device sign-in first; it replaces that token)
apps/wadd/dev/try-network.sh   # NetworkManager for real: status and networks in range
                               # (--join SSID / --forget SSID change things)
apps/wadd/dev/try-stream.sh    # streams for real: TLS, the password, a remote view
                               # (VIEW=1: and Wad Creator's stream window)
apps/wadd/dev/try-app.sh       # the machine app's spike against `wadd serve --user`
sudo target/debug/wadd keys    # the keyboard proxy for 20 s (prints what Super chords would do)
```

A few scripts need extra pieces:
- `try-view.sh` and `try-build.sh` need sway. Unpacked under `.build/sway` is enough (`dev/sway.sh` says how).
- `try-build.sh` and `try-stream.sh` need the images: `images/build.sh`.

## History

This repo was made on 2026-10-02 from older repos. Their history is kept as the second parent of the import merges:
- `WadCreator` → `apps/wadcreator/`;
- `Wadspaces-Tools` (`Workspace-Switcher`) → the Python wadd (removed after the cutover to the Rust one) and `host/`.

`images/` came from `Wadspaces-David`'s `_common` and `_stream` on 2026-10-04, without their history. That repo's hand-written workspaces aren't needed any more: the Builder makes workspaces now.
