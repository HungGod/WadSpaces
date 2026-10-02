# WadSpaces

The software that runs a WadSpaces machine, and the Wad Creator app used to design and run wadspaces.

| Path | What it is |
|---|---|
| `apps/wadcreator/` | Wad Creator: the React UI. Built for three targets (`src/lib/machine.ts`): the web portal (`online`, `wad-spaces.web.app`), the machine app (`machine`, inside Tauri: the kiosk's shell), and `offline` (development against a dev wadd). The Firebase function and Firestore rules are here too. |
| `host/` | The machine's OS image (Fedora bootc, sway, Wad Creator as the shell), and `host/build.sh` to build it and write it to a drive. |
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

Try it on a laptop, in a window, without the host image:

```bash
legacy/wadd-py/dev/run-app.sh    # a dev wadd on :8080, then the app with hot reload
```

You sign in with your real account (Firebase). The dev wadd has no cloud settings, so the laptop isn't linked and setup skips that step. Wi-Fi and Power in the app act on the laptop for real. State is kept in `~/.local/state/wadspaces-dev`.

```bash
cd apps/wadcreator
npm run app          # the app alone (expects wadd on 127.0.0.1:8080, or WADD_URL)
npm run build:app    # release build at target/release/wadcreator (--kiosk for fullscreen)
```

The Rust toolchain is pinned in `rust-toolchain.toml`. On Fedora the app also needs `webkit2gtk4.1-devel javascriptcoregtk4.1-devel libsoup3-devel gtk3-devel librsvg2-devel` (and `binaryen` for the wasm build).

## History

This repo was made on 2026-10-02 from two older repos. Their history is kept as the second parent of the two import merges:
- `WadCreator` → `apps/wadcreator/`;
- `Wadspaces-Tools` (`Workspace-Switcher`) → `legacy/wadd-py/`, with its `host/` moved to the top.
