#!/usr/bin/env bash
# Tries the Rust wadd's view on this laptop, against a real sway: a headless
# sway (no window on your desktop) with the machine's sway rules, the Rust
# wadd as you, and a real lean workspace whose desktop opens as a window in
# that sway. Checks adoption, switching, Super+Tab (by API), focus rules and
# stop.
#
#   apps/wadd/dev/try-view.sh [image]     default localhost/wadspaces-cosmic-bodybuilding:latest
#
# Needs sway: installed, or unpacked under .build/sway (no root needed):
#   cd .build/sway && dnf download sway sway-config-upstream wlroots libseat libliftoff xcb-util-errors \
#     && for r in *.rpm; do rpm2cpio $r | cpio -idm; done
set -euo pipefail
ulimit -c 0
root=$(cd "$(dirname "$0")/../../.." && pwd)
image=${1:-localhost/wadspaces-cosmic-bodybuilding:latest}
dir=$root/.build/wadd-try-view
sock=$dir/wadd.sock
# sway's runtime dir: under yours, because a native workspace mounts
# $XDG_RUNTIME_DIR (and is pointed at this socket by WADSPACES_WAYLAND).
rt_name=wadd-try-sway
rt=$XDG_RUNTIME_DIR/$rt_name
rm -rf "$dir" "$rt"
mkdir -p "$dir/state" "$dir/projects"
mkdir -m 700 "$rt"

if command -v sway >/dev/null; then sway=sway; swaymsg=swaymsg; libs=
else sway=$root/.build/sway/usr/bin/sway; swaymsg=$root/.build/sway/usr/bin/swaymsg; libs=$root/.build/sway/usr/lib64; fi
podman image exists localhost/wadspaces-test:latest ||
  podman build -q -t localhost/wadspaces-test:latest "$root/apps/wadd/dev/test-image" >/dev/null

# The machine's sway rules, without its programs.
{ grep -v '^exec ' "$root/host/etc/sway/wadspaces.conf"; echo 'output HEADLESS-1 resolution 1280x800'; } >"$dir/sway.conf"
env -u WAYLAND_DISPLAY -u DISPLAY XDG_RUNTIME_DIR="$rt" WLR_BACKENDS=headless WLR_RENDERER=pixman \
  WLR_LIBINPUT_NO_DEVICES=1 ${libs:+LD_LIBRARY_PATH=$libs} "$sway" -c "$dir/sway.conf" >"$dir/sway.log" 2>&1 &
sway_pid=$!
for _ in $(seq 50); do ls "$rt"/sway-ipc.*.sock >/dev/null 2>&1 && [ -S "$rt/wayland-1" ] && break; sleep 0.1; done
ipc=$(ls "$rt"/sway-ipc.*.sock)
sm() { env ${libs:+LD_LIBRARY_PATH=$libs} "$swaymsg" -s "$ipc" "$@"; }

cat >"$dir/wadd.toml" <<TOML
[machine]
name = "wadd-try-view"
[daemon]
socket = "$sock"
state_dir = "$dir/state"
projects_dir = "$dir/projects"
legacy_config = "$dir/none.yaml"
ready_timeout_s = 120
[display]
socket = "$ipc"
TOML
cat >"$dir/state/workspaces.json" <<JSON
[{"id":"trynative","name":"Try native","image":"$image","display":"host","hotkey":1,"enabled":true,"autostart":false,
  "containerName":"wad-trynative","containerPort":3000,
  "env":[["PUID","1000"],["PGID","1000"],["WADSPACES_WAYLAND","$rt_name/wayland-1"]],
  "secrets":[],"volumes":[],"devices":[],"shmSize":"1g","projects":[]},
 {"id":"trystream","name":"Try stream","image":"localhost/wadspaces-test:latest","display":"stream","port":3198,"hotkey":2,
  "enabled":true,"autostart":false,"containerName":"wad-trystream","containerPort":3000,
  "env":[],"secrets":[],"volumes":[],"devices":[],"projects":[]}]
JSON

(cd "$root" && cargo build -q -p wadd)
"$root/target/debug/wadd" serve --user --config "$dir/wadd.toml" >"$dir/wadd.log" 2>&1 &
wadd_pid=$!
finish() {
  kill "$wadd_pid" 2>/dev/null || true
  wait "$wadd_pid" 2>/dev/null || true
  systemctl --user stop wad-trynative.service wad-trystream.service 2>/dev/null || true
  rm -f "$XDG_RUNTIME_DIR"/containers/systemd/wad-try*.container
  systemctl --user daemon-reload
  kill "$sway_pid" 2>/dev/null || true
  wait "$sway_pid" 2>/dev/null || true
  rm -rf "$rt"
}
trap finish EXIT
for _ in $(seq 50); do [ -S "$sock" ] && break; sleep 0.1; done

api() { curl -sS --unix-socket "$sock" -X "$1" ${3:+-H 'Content-Type: application/json' -d "$3"} -w ' %{http_code}' "http://wadd$2"; echo; }
view() { curl -sS --unix-socket "$sock" http://wadd/v1/view | sed -n 's/.*"view":\({[^}]*}\).*"pending":\([^,]*\).*/\1 pending=\2/p'; }
until_view() { # substring
  for _ in $(seq 1200); do view | grep -q "$1" && return 0; sleep 0.1; done
  echo "timed out: $(view)"; tail -5 "$dir/wadd.log"; return 1
}
focused() { sm -t get_workspaces | python3 -c 'import json,sys; print(next(w["name"] for w in json.load(sys.stdin) if w["focused"]))'; }
where() { # the workspace's window: its sway workspace and whether it's fullscreen and focused
  sm -t get_tree | python3 -c '
import json, sys
def walk(n, ws=None):
    if n.get("type") == "workspace": ws = n["name"]
    if n.get("pid") and n.get("type") in ("con", "floating_con"):
        print(ws, "fullscreen" if n.get("fullscreen_mode") else "tiled", "focused" if n.get("focused") else "", n.get("app_id"))
    for c in n.get("nodes", []) + n.get("floating_nodes", []): walk(c, ws)
walk(json.load(sys.stdin))'
}
elapsed() { echo "$(( ($(date +%s%N) - t0) / 1000000 )) ms"; }

echo "== sway is up; wadd sees it"
until_view '"kind":"home"'; api GET /v1/view
echo "== switch to the native workspace (cold): the screen stays put until its window is up"
t0=$(date +%s%N); api POST /v1/workspaces/trynative/switch
until_view '"kind":"workspace","id":"trynative"'; echo "shown after $(elapsed)"
where; echo "focused workspace: $(focused)"
echo "== Super+Tab (by API) back to Wad Creator"
api POST /v1/carousel/next; api POST /v1/carousel/commit
until_view '"kind":"home"'; echo "focused workspace: $(focused)"
echo "== switch again (warm)"
t0=$(date +%s%N); api POST /v1/workspaces/trynative/switch >/dev/null
until_view '"id":"trynative"'; echo "shown after $(elapsed); focused workspace: $(focused)"
echo "== a focus session on it: Wad Creator and the other workspace wait"
api POST /v1/session '{"workspaces":["trynative"],"minutes":5}'
api POST /v1/workspaces/trynative/switch >/dev/null
api POST /v1/view/home
api POST /v1/workspaces/trystream/switch
api GET /v1/session
api DELETE '/v1/session?force=true'
echo "== stop it: its window closes, back to Wad Creator"
t0=$(date +%s%N); api POST /v1/workspaces/trynative/stop; echo "stopped after $(elapsed)"
until_view '"kind":"home"'; where; echo "focused workspace: $(focused)"
echo "== wadd's log"
grep -E "sway|window|ready|session|key" "$dir/wadd.log" | tail -12
