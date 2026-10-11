# Images

What wadspaces run on. `base` is built here; the Builder's layers are built
on it by wadd, on the machine.

| Image | What it is |
|---|---|
| `localhost/wadspaces-base:trixie` (`base/`) | The lean desktop (labwc, selkies-desktop's icons and panel with the WadSpaces logo, Xwayland), WadBrowser (the browser, every web app's window, and what links open in), and the helpers layers build with: `wadspaces-feature` (one script per app or tool, `base/root/usr/local/lib/wadspaces/features/`), `wadspaces-apt`, `wadspaces-webapp`, `wadspaces-vscode-extensions`, `wadspaces-layout`. Its window goes on whatever compositor is mounted at `/run/wadspaces-display`. `build.sh` builds WadBrowser for it first, in `builder/` (a Debian container with Rust and WebKitGTK's headers), and stages Dolphin from linuxserver's image. |
| `localhost/wadspaces-template-<id>:latest` | A template: `FROM` the base, with its apps. |
| `localhost/wadspaces-custom-<id>:latest` | A customization: `FROM` its template's image, with tools, VS Code extensions and web apps. |
| `localhost/wadspaces-<name>:latest` (`examples/`) | Hand-written images on the base, as examples (`writing`, `iq-dev`), and the images of wadspaces from before the layers. |

A wadspace has no image of its own: its wallpaper, project folders and saved
sign-ins are mounted when it starts. Layer images carry labels wadd reads:
`io.wadspaces.layer`, `io.wadspaces.dockerfile-sha256` (the build folder's
sha, so a changed layer shows as changed) and `io.wadspaces.from` (the image
it was built on). wad-core writes their build folders
(`crates/wad-core/src/layers.rs`), and wadd builds them
(`POST /v1/images/build`), a customization's template first.

```bash
images/build.sh                    # the base
images/build.sh --example writing  # an example (the base first, if missing)
images/base/try-apps.sh            # every catalog app over the base, opened in a headless sway
images/base/try-signins.sh         # each sign-in kind's files kept across runs
apps/wadd/dev/try-layers.sh        # a template and customization built by wadd, a wadspace on them
```

A machine gets the base from its drive: `host/build.sh install` brings it, and
`host/build.sh update --bases` updates it. Layer images are built on the
machine the first time something needs them.
