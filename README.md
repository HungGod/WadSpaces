# WadSpaces

The software that runs a WadSpaces machine, and the Wad Creator app used to design and run wadspaces.

| Path | What it is |
|---|---|
| `apps/wadcreator/` | Wad Creator: the React UI. It has two targets: the web portal (`wad-spaces.web.app`, Firebase) and the app on the machine (Tauri, coming in stage 1a). The Firebase function and Firestore rules are here too. |
| `host/` | The machine's OS image (Fedora bootc, sway), and `host/build.sh` to build it and write it to a drive. |
| `legacy/wadd-py/` | wadd, the machine daemon, in Python. It is frozen while the Rust wadd is written (stage 2), then removed. |
| `fixtures/quadlet/` | Unit files and workspace specs that every renderer must reproduce byte for byte (wadd's tests and the UI's generator tests read these). |
| `apps/wadcreator/src-tauri/` | The machine app: Tauri around the same React UI. Its Rust side holds the commands the UI calls (`src/gen/bindings.ts` is generated from them). |
| `crates/` | Shared Rust crates: `wad-proto` (types shared by wadd, the app and the UI), `wad-github` (device-flow sign-in), `wad-firebase` (Firestore writes made from Rust). |
| `apps/wadd/` | The Rust wadd (stage 2). |

The container images themselves are in the separate `Wadspaces-David` checkout, next to this one (`../Wadspaces-David`).

## Tests

```bash
cargo xtask ci                                         # everything below except the rules tests
cargo test --workspace                                 # Rust
(cd legacy/wadd-py && .venv/bin/python -m pytest -q)   # wadd
(cd apps/wadcreator && npm test && npm run typecheck)  # UI
(cd apps/wadcreator && npm run test:rules)             # Firestore rules (emulator)
```

After changing a Tauri command or a `wad-proto` type, run `cargo xtask bindings` (a test fails until you do).

## The machine app

```bash
cd apps/wadcreator
npm run app          # dev: a window on Vite's dev server, with hot reload
npm run build:app    # release build at target/release/wadcreator (--kiosk for fullscreen)
```

The Rust toolchain is pinned in `rust-toolchain.toml`. On Fedora the app also needs `webkit2gtk4.1-devel javascriptcoregtk4.1-devel libsoup3-devel gtk3-devel librsvg2-devel` (and `binaryen` for the wasm build).

## History

This repo was made on 2026-10-02 from two older repos. Their history is kept as the second parent of the two import merges:
- `WadCreator` → `apps/wadcreator/`;
- `Wadspaces-Tools` (`Workspace-Switcher`) → `legacy/wadd-py/`, with its `host/` moved to the top.
