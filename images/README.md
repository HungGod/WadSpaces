# Images

What workspaces are made from. WadSpaces Client's Builder designs a workspace and
wadd builds it on the machine, on `base`; nothing here needs building per
workspace.

| Directory | Image | What it is |
|---|---|---|
| `base/` | `localhost/wadspaces-base:trixie` | The lean desktop (labwc, the icon panel, Xwayland), WadBrowser (the browser, every web app's window, and what links open in) and the build helpers designs use: `wadspaces-feature`, `wadspaces-apt`, `wadspaces-webapp`, `wadspaces-layout`. Its window goes on whatever compositor is mounted at `/run/wadspaces-display`. `build.sh` builds WadBrowser for it first, in `builder/` (a Debian container with Rust and WebKitGTK's headers). |
| `examples/` | `localhost/wadspaces-<name>:latest` | Two hand-written workspaces, `writing` and `iq-dev`, as examples of an image on the base. |

```bash
images/build.sh                    # the base
images/build.sh --example writing  # an example (the base first, if missing)
```

A machine gets the base from its drive: `host/build.sh install` brings it, and
`host/build.sh update --bases` updates it.
