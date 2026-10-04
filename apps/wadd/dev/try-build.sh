#!/usr/bin/env bash
# Tries the Rust wadd's builds on this laptop, as you: a design (as Wad
# Creator sends it) is made into a build folder by wad-core, with its web
# apps' icons made first (wad-icons), built by your rootless podman on the
# lean base, added as a workspace, and opened in a headless sway (a
# screenshot of its desktop: desktop.png); then built again (an update: the
# cache makes it quick).
#
#   apps/wadd/dev/try-build.sh
#
# Needs localhost/wadspaces-base:trixie (images/build.sh --only base) and sway
# (see sway.sh). The image and units are removed afterwards.
set -euo pipefail
ulimit -c 0
root=$(cd "$(dirname "$0")/../../.." && pwd)
dir=$root/.build/wadd-try-build
sock=$dir/wadd.sock
rm -rf "$dir"
mkdir -p "$dir/state" "$dir/projects"
podman image exists localhost/wadspaces-base:trixie || { echo "no localhost/wadspaces-base:trixie: images/build.sh --only base" >&2; exit 1; }
# wadd talks to podman's API socket (rootless: the user's).
[ -S "$XDG_RUNTIME_DIR/podman/podman.sock" ] || systemctl --user start podman.socket
. "$root/apps/wadd/dev/sway.sh"
start_sway "$dir"

cat >"$dir/wadd.toml" <<TOML
[machine]
name = "wadd-try-build"
[daemon]
socket = "$sock"
state_dir = "$dir/state"
projects_dir = "$dir/projects"
legacy_config = "$dir/none.yaml"
ready_timeout_s = 180
build_min_free_gb = 2
[display]
socket = "$ipc"
TOML
echo '[]' >"$dir/state/workspaces.json"

(cd "$root" && cargo build -q -p wadd)
"$root/target/debug/wadd" serve --user --config "$dir/wadd.toml" >"$dir/wadd.log" 2>&1 &
wadd_pid=$!
finish() {
  kill "$wadd_pid" 2>/dev/null || true
  wait "$wadd_pid" 2>/dev/null || true
  systemctl --user stop wad-trybuild.service 2>/dev/null || true
  rm -f "$XDG_RUNTIME_DIR"/containers/systemd/wad-trybuild.container
  systemctl --user daemon-reload
  podman rmi -i localhost/wadspaces-trybuild:latest >/dev/null 2>&1 || true
  stop_sway
}
trap finish EXIT
for _ in $(seq 50); do [ -S "$sock" ] && break; sleep 0.1; done
api() { curl -sS --unix-socket "$sock" -X "$1" "http://wadd$2"; echo; }
post() { curl -sS --unix-socket "$sock" -X POST -H 'Content-Type: application/json' --data-binary @- "http://wadd$1"; echo; }
view() { curl -sS --unix-socket "$sock" http://wadd/v1/view; }

# The design, as Wad Creator keeps it, and a wallpaper it would have drawn.
request() { # name
  python3 - "$1" "$rt_name" <<'PY'
import json, sys
png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
def icon(app, row, **extra):
    return {"id": f"{app}-{row}", "appId": app, "label": extra.pop("label", app), "iconUrl": "", "color": "#000",
            "x": 0, "y": 0, "cell": {"col": 0, "row": row}, **extra}
# WadBrowser, two catalog web apps (their sites' icons) and a dev server's
# (on this network: a card with its name).
icons = [icon("wadbrowser", 0, label="WadBrowser"), icon("github", 1, label="GitHub"), icon("claude", 2, label="Claude"),
         icon("custom-dev", 3, label="Dev server", url="http://localhost:5173")]
design = {"id": "trybuild", "name": sys.argv[1], "description": "",
  "layout": {"wallpaper": {"type": "color", "value": "#203040"}, "icons": icons, "grid": True},
  "advanced": {"display": "host", "port": None, "hotkey": 2, "tools": [], "projects": [],
    "env": {"PUID": "1000", "PGID": "1000", "WADSPACES_WAYLAND": sys.argv[2] + "/wayland-1"},
    "secrets": [], "devices": [], "shmSize": "1g", "persistConfig": False, "autostart": False}}
print(json.dumps({"design": design, "wallpaper": {"fileName": "wallpaper.png", "data": png}}))
PY
}
build() { # name
  local id t0 out
  t0=$(date +%s%N)
  out=$(request "$1" | post /v1/builds)
  id=$(python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("id") or sys.exit(str(d)))' <<<"$out")
  for _ in $(seq 3000); do
    out=$(curl -sS --unix-socket "$sock" "http://wadd/v1/builds/$id")
    grep -q '"status":"\(done\|error\|cancelled\)"' <<<"$out" && break
    sleep 0.2
  done
  python3 -c '
import json, sys
l = json.load(sys.stdin); b = l["build"]
print("status:", b["status"], b["error"] or "", "| updated:", b["updated"], "| restart required:", b["restartRequired"])
for line in l["lines"]:
    if line.startswith(("STEP", "»", "✓", "✗", "⚠", "added", "updated", "Error")): print("  |", line)' <<<"$out"
  echo "  took $(( ($(date +%s%N) - t0) / 1000000 )) ms"
  grep -q '"status":"done"' <<<"$out" || { echo "the build failed: stopping"; exit 1; }
}

echo "== build a design"
build "Try build"
api GET /v1/workspaces/trybuild
echo "== in the image: web apps' launchers and icons, and what links open in"
podman run --rm --entrypoint sh localhost/wadspaces-trybuild:latest -c '
  for f in /usr/share/applications/wadspaces-webapp-*.desktop; do grep -h "^Exec=" "$f"; done
  ls -la /usr/share/icons/hicolor/512x512/apps/ | grep webapp
  grep -v "^#" /etc/wadspaces/wadbrowser.conf
  for i in /usr/share/icons/hicolor/512x512/apps/wadspaces-webapp-*.png; do cp "$i" /dev/null; done' 2>&1 | sed 's/^/  | /'
podman run --rm --entrypoint sh localhost/wadspaces-trybuild:latest -c 'tar -C /usr/share/icons/hicolor/512x512/apps -cf - .' \
  | tar -C "$dir" -xf - --wildcards './wadspaces-webapp-*' 2>/dev/null || true
echo "== open it: its desktop's window in sway"
api POST /v1/workspaces/trybuild/switch >/dev/null
for _ in $(seq 600); do view | grep -q '"id":"trybuild"' && break; sleep 0.2; done
view; echo; where; echo "focused workspace: $(focused)"
sleep 6
grim_bin=$(command -v grim || echo "$root/.build/sway/usr/bin/grim")
env XDG_RUNTIME_DIR="$rt" WAYLAND_DISPLAY=wayland-1 ${libs:+LD_LIBRARY_PATH=$libs} "$grim_bin" "$dir/desktop.png" \
  && echo "  desktop: $dir/desktop.png" || echo "  (no screenshot: grim missing)"
echo "== in it: a web app's launcher, then a link (xdg-open), as abc"
# The desktop's own environment (its Wayland display), from labwc's process.
podman exec -u abc wad-trybuild sh -c '
  pid=$(pgrep -u abc -x labwc | head -1)
  eval "$(tr "\0" "\n" < /proc/$pid/environ | grep -E "^(WAYLAND_DISPLAY|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS)=" | sed "s/^/export /")"
  cd /config
  gio launch /usr/share/applications/wadspaces-webapp-github.desktop > /tmp/wb-app.log 2>&1 &
  sleep 6
  start=$(date +%s%N); xdg-open "data:text/html,<title>A link</title><h1>opened by xdg-open</h1>" > /tmp/wb-link.log 2>&1
  echo "  xdg-open handed over in $(( ($(date +%s%N) - start) / 1000000 )) ms"
  sleep 5
  ps -o pid,rss,args -u abc | grep -E "wadbrowser|WebKit" | grep -v grep | cut -c1-120
  tail -3 /tmp/wb-app.log' || true
env XDG_RUNTIME_DIR="$rt" WAYLAND_DISPLAY=wayland-1 ${libs:+LD_LIBRARY_PATH=$libs} "$grim_bin" "$dir/apps.png" \
  && echo "  with apps open: $dir/apps.png" || true
echo "== build it again, renamed (an update; it's running, so it needs a restart)"
build "Try build 2"
api GET /v1/workspaces/trybuild | grep -o '"name":"[^"]*"'
echo "== wadd's log"
grep -E "warn|error|ready|window" "$dir/wadd.log" | tail -6 || true
