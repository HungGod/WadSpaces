# WadSpaces

The software that runs a WadSpaces machine, and the Wad Creator app used to design and run wadspaces.

| Path | What it is |
|---|---|
| `apps/wadcreator/` | Wad Creator: the React UI. It has two targets: the web portal (`wad-spaces.web.app`, Firebase) and the app on the machine (Tauri, coming in stage 1a). The Firebase function and Firestore rules are here too. |
| `host/` | The machine's OS image (Fedora bootc, sway), and `host/build.sh` to build it and write it to a drive. |
| `legacy/wadd-py/` | wadd, the machine daemon, in Python. It is frozen while the Rust wadd is written (stage 2), then removed. |
| `fixtures/quadlet/` | Unit files and workspace specs that every renderer must reproduce byte for byte (wadd's tests and the UI's generator tests read these). |
| `crates/`, `apps/wadd/` | The Rust workspace: shared crates and the new wadd (stage 1 onward). |

The container images themselves are in the separate `Wadspaces-David` checkout, next to this one (`../Wadspaces-David`).

## Tests

```bash
(cd legacy/wadd-py && .venv/bin/python -m pytest -q)   # wadd
(cd apps/wadcreator && npm test && npm run typecheck)  # UI
(cd apps/wadcreator && npm run test:rules)             # Firestore rules (emulator)
```

## History

This repo was made on 2026-10-02 from two older repos. Their history is kept as the second parent of the two import merges:
- `WadCreator` → `apps/wadcreator/`;
- `Wadspaces-Tools` (`Workspace-Switcher`) → `legacy/wadd-py/`, with its `host/` moved to the top.
