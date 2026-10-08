# Writing workspace (an example)

Obsidian and the `HungGod/Writing` vault, on the WadSpaces base image
(`../../base`), which provides git auth, mounted projects, desktop launchers,
the wallpaper and the blanked Selkies icon. This image adds Obsidian
(`wadspaces-feature obsidian`) and `init-writing-vault`, which pins the vault in
`obsidian.json`. On a machine its desktop is a window on the screen (wadd's
`display: host`); run by hand, it's a window on your own Wayland desktop.

Workspaces are made in WadSpaces Client's Builder now; this one is hand-written, as
an example of what goes into an image.

## Build and try it

```bash
# 1. GitHub token — fine-grained. Both of these must be set:
#      Repository access      -> the vault repo is in the list
#      Repository permissions -> Contents: Read and write
#                                (Metadata: Read-only is auto-enabled)
#    Contents is what git over HTTPS uses. Pull requests is NOT enough:
#    a token without Contents fails with
#      remote: Write access to repository not granted.
printf '%s' '<fine-grained PAT>' | podman secret create github_token -

# 2. build (the base image first, if it's missing), then run it: it opens as a
#    window on this desktop
images/build.sh --example writing
cd images/examples/writing && podman-compose up -d
```

On a WadSpaces machine, wadd runs the image itself, on the machine's screen.

## How the pieces fit

### Git auth

No SSH keys and no host bind-mounts. The token lives only in podman's secret
store and is exposed read-only at `/run/secrets/github_token`.

`/usr/local/bin/git-credential-github-token` (from the base image) is a git credential helper that
reads the token at request time and prints it to git on stdout. It is wired up
at init with:

```
git config --global credential.https://github.com.helper   /usr/local/bin/git-credential-github-token
git config --global credential.https://github.com.username x-access-token
```

The token is never written into `.git/config`, into `/config`, or into the image.
It also works from inside the desktop session (e.g. the obsidian-git plugin),
because the helper reads the secret file rather than depending on environment.

`$GITHUB_TOKEN` is accepted as a fallback if you would rather pass it as an env
var, but the secret is the better path.

### Shortcuts

The Selkies desktop (`selkies-desktop`) draws an icon for every `.desktop` file
in `$HOME/Desktop`, and lists apps from `/usr/share/applications`. So the entries
are **shipped in the image** and **copied into `~/Desktop` at init**:

| File | Purpose |
|---|---|
| `/usr/share/applications/md.obsidian.Obsidian.desktop` | written by the `obsidian` feature; desktop icon + app list |
| `/etc/wadspaces/desktop-entries.d/obsidian.list` | tells the base init to seed it into `~/Desktop` |
| `/config/.config/labwc/menu.xml` | right-click menu, rebuilt each boot from the seeded launchers + a terminal |
| `/defaults/autostart_wayland` | starts `swaybg` for the wallpaper and runs `/etc/wadspaces/autostart.d/*.sh` |

Init also deletes `~/Desktop/writing-files.desktop` if it finds one, so the
retired Dolphin shortcut does not linger on a `/config` that survived a restart.

### The blanked start icon

`selkies-desktop` has a single global `start_icon`, loaded from
`/usr/share/selkies/www/icon.png` and drawn in **two** places: at native size in
the dead centre of the desktop (`ui.c` `draw_bg`) and scaled to 16px in the
panel's start button (`ui.c` `draw_panel`). One file feeds both, so there is no
way to show it in the tray without also stamping it across the middle of the
wallpaper.

The Dockerfile therefore writes a 1x1 fully transparent PNG there. Both draws
become invisible; the start button is a plain grey rectangle that still opens
the menu.

Two things to know if you revisit this:

- The button only falls back to the word "Start" when the image fails to
  *load*. A valid-but-transparent PNG loads fine, so you get a blank button.
  Deleting the file would give you the "Start" label instead — but
  `icon.png` is also referenced by `web/manifest.json` and both index pages, so
  deleting it 404s the PWA icon.
- The 1x1 transparent PNG that turns up in search results
  (`...AAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAA...`) is **not** transparent — it is
  a half-opaque blue pixel, `rgba(0,0,255,0.5)`, which renders as a faint blue
  square in the tray. The one in the Dockerfile was generated and checked.

Obsidian keeps its own logo on the desktop launcher and in the right-click
menu, copied out of the AppImage to
`/usr/share/icons/hicolor/512x512/apps/obsidian.png`.

The panel rescans when `~/.config/panel-reload` is touched, which init does last.

### Wallpaper

`selkies-desktop` has no wallpaper of its own — it clears its background surface
to fully transparent (`CAIRO_OPERATOR_CLEAR`) and paints only the desktop icons
and a centred logo onto it. So the wallpaper is drawn *underneath* by `swaybg`,
started from `root/defaults/autostart_wayland`, and shows through.

The image ships at `/usr/share/backgrounds/wallpaper.png`. Point `WALLPAPER` at any
other path — including a file inside the vault — to change it.

The centred logo `selkies-desktop` draws on top is
`/usr/share/selkies/www/icon.png`, which this image blanks out (see above).
So the wallpaper is unobstructed.

`swaybg` is Wayland-only, so the X11 `autostart` has no wallpaper — irrelevant
while `PIXELFLUX_WAYLAND=true`.

### Persistence

`/config` is ephemeral. Only `/config/.config/obsidian` is a named volume, so
Obsidian's vault list, theme and appearance survive. The vault itself is the
**Writing project**: a folder on the host that wadd mounts read-write at
`/config/Desktop/Writing` (with `--run`, the `WRITING_VAULT` path in
`docker-compose.yml`). Writing lands on the host the moment it's saved, so a
recreate loses nothing; push to GitHub from inside whenever you like.

The `:z` on that volume mount is **required on SELinux hosts** (Fedora here).
Podman gives each container its own MCS category pair, and without `:z` the
files inside a named volume keep the categories of whichever container created
them. On the next `up -d` you get a mismatch and even root inside the container
is denied:

```
avc: denied { write } ... scontext=container_t:s0:c37,c260
                          tcontext=container_file_t:s0:c85,c628
```

`:z` makes podman relabel the volume contents on every mount, so it tracks the
current container. If setroubleshoot suggests `audit2allow -M my-bash`, ignore
it — that writes a permanent policy exception around a fixable mount option.

**Per-vault Obsidian settings** (plugins, hotkeys, themes, CSS snippets) live
in `$VAULT_DIR/.obsidian/`. Now that the vault is a folder on the host, `.obsidian/` persists with it;
it's still kept out of git by the vault's `.gitignore`.

## Environment

Set in the image; override in `docker-compose.yml` if needed.

| Variable | Default | Purpose |
|---|---|---|
| `SELKIES_DESKTOP` | `true` | desktop + panel. Without it there are no desktop icons at all. |
| `AUTOSTART_OBSIDIAN` | `false` | `true` boots straight into fullscreen Obsidian instead of the desktop |
| `VAULT_DIR` | `/config/Desktop/Writing` | vault location; must match the Writing project's folder name (its mount) |
| `GITHUB_TOKEN_FILE` | `/run/secrets/github_token` | where the credential helper looks |
| `PIN_VAULT` | `true` | rewrite `obsidian.json` so Obsidian opens this vault |
| `REFRESH_MENU` | `true` | rebuild `~/.config/labwc/menu.xml` from the desktop launchers each boot |
| `WALLPAPER` | `/usr/share/backgrounds/wallpaper.png` | wallpaper image; empty or missing disables it |
| `WALLPAPER_MODE` | `center` | any `swaybg` mode: `center`, `fit`, `fill`, `stretch`, `tile` |
| `WALLPAPER_COLOR` | `#0b0b14` | fill colour around the image |

`REFRESH_MENU` exists because the Selkies image's `init-selkies-config` only copies
the menu when the user's copy is *absent* — a persisted `~/.config` would
otherwise pin you to a stale menu forever. Note it always adds a terminal
entry, so leave it `false` if you use `DISABLE_TERMINALS=true`.

The vault is not fetched by the image at all: it is the Writing project,
mounted at start.

## Checks

```bash
# init log; the token must never appear in it
podman logs wad-writing | grep -iE 'wadspaces-workspace|writing-vault|ls.io-init'
podman logs wad-writing | grep -i 'github_pat'              # must be empty

# auth works as the desktop user
podman exec -u abc wad-writing git -C /config/Desktop/Writing ls-remote origin
podman exec -u abc wad-writing ls -la /config/Desktop        # obsidian launcher + vault, abc-owned

# token is not on disk where it shouldn't be
podman exec wad-writing grep -r 'github_pat' /config 2>/dev/null   # must be empty
```

If a push fails, check what the token can actually reach:

```bash
podman exec wad-writing bash -c '
T=$(tr -d "\r\n" < /run/secrets/github_token)
curl -s -H "Authorization: Bearer $T" https://api.github.com/user \
  | grep -oE "\"login\": \"[^\"]*\""
curl -s -o /dev/null -w "vault repo http=%{http_code}\n" \
  -H "Authorization: Bearer $T" https://api.github.com/repos/HungGod/Writing
curl -s -H "Authorization: Bearer $T" "https://api.github.com/user/repos?per_page=100" \
  | grep -oE "\"full_name\": \"[^\"]*\""'
```

- `404` on the vault repo → the repo is not in the token's **Repository access** list
  (or the name is wrong).
- `403 Write access to repository not granted` from git → the token is missing
  **Contents: Read and write**.

After editing the token on GitHub its value does not change, so the podman
secret stays valid — just `podman restart wad-writing`.
