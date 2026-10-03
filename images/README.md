# Images

What workspaces are made from. Wad Creator's Builder designs a workspace and
wadd builds it on the machine, on `base`; nothing here needs building per
workspace.

| Directory | Image | What it is |
|---|---|---|
| `base/` | `localhost/wadspaces-base:trixie` | The lean desktop (labwc, the icon panel, Xwayland) and the build helpers designs use: `wadspaces-feature`, `wadspaces-apt`, `wadspaces-webapp`, `wadspaces-layout`. Its window goes on whatever compositor is mounted at `/run/wadspaces-display`. |
| `stream/` | `localhost/wadspaces-stream:trixie` | The stream sidecar (Selkies): the compositor a workspace draws on when it's viewed from another device. |
| `examples/` | `localhost/wadspaces-<name>:latest` | Two hand-written workspaces, `writing` and `iq-dev`, as examples of an image on the base. |

```bash
images/build.sh                    # base and stream
images/build.sh --example writing  # an example (the bases first, if missing)
```

A machine gets the bases from its drive: `host/build.sh update /dev/sdX --bases`.
