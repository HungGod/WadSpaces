#!/usr/bin/env bash
# Tries the machine's own apps (the terminal and WadBrowser: workspaces of
# kind "app") on this laptop, against a real sway: a headless sway with the
# machine's sway rules, the Rust wadd as you, and each app run in a transient
# unit of your user manager (wad-<id>.service), as on a machine it runs in
# the system manager as the kiosk user. Checks adoption (full screen on its
# own sway workspace), Super+Tab (by API), no Super+number, restart, stop,
# and an app that exits by itself leaving the screen.
#
#   apps/wadd/dev/try-apps.sh
#
# Needs sway and foot: installed, or unpacked under .build/sway (no root):
#   cd .build/sway && dnf download sway sway-config-upstream wlroots libseat libliftoff xcb-util-errors \
#     foot fcft utf8proc && for r in *.x86_64.rpm *.noarch.rpm; do rpm2cpio $r | cpio -idm; done
# and WadBrowser built: cargo build --profile wadbrowser -p wadbrowser (or
# WADBROWSER=path/to/wadbrowser).
set -euo pipefail
ulimit -c 0
root=$(cd "$(dirname "$0")/../../.." && pwd)
dir=$root/.build/wadd-try-apps
sock=$dir/wadd.sock
rm -rf "$dir"
mkdir -p "$dir/state" "$dir/projects"
. "$root/apps/wadd/dev/sway.sh"
start_sway "$dir"

if command -v foot >/dev/null; then foot=$(command -v foot); foot_libs=
else foot=$root/.build/sway/usr/bin/foot; foot_libs=$root/.build/sway/usr/lib64; fi
browser=${WADBROWSER:-$root/target/wadbrowser/wadbrowser}
[ -x "$browser" ] || { echo "no WadBrowser at $browser: cargo build --profile wadbrowser -p wadbrowser" >&2; exit 1; }

cat >"$dir/wadd.toml" <<TOML
[machine]
name = "wadd-try-apps"
[daemon]
socket = "$sock"
state_dir = "$dir/state"
projects_dir = "$dir/projects"
vendor_workspaces = "$dir/none.d"
ready_timeout_s = 60
[display]
socket = "$ipc"
TOML
cat >"$dir/state/workspaces.json" <<JSON
[{"id":"terminal","name":"Terminal","kind":"app","exec":["$foot"],"image":"","display":"host","hotkey":null,
  "enabled":true,"autostart":false,"containerName":"wad-terminal","containerPort":3000,
  "env":[["LD_LIBRARY_PATH","$foot_libs"]],"secrets":[],"volumes":[],"devices":[],"shmSize":null,"projects":[]},
 {"id":"browser","name":"WadBrowser","kind":"app","exec":["$browser"],"image":"","display":"host","hotkey":null,
  "enabled":true,"autostart":false,"containerName":"wad-browser","containerPort":3000,
  "env":[],"secrets":[],"volumes":[],"devices":[],"shmSize":null,"projects":[]}]
JSON

(cd "$root" && cargo build -q -p wadd)
"$root/target/debug/wadd" serve --user --config "$dir/wadd.toml" >"$dir/wadd.log" 2>&1 &
wadd_pid=$!
finish() {
  kill "$wadd_pid" 2>/dev/null || true
  wait "$wadd_pid" 2>/dev/null || true
  systemctl --user stop wad-terminal.service wad-browser.service 2>/dev/null || true
  stop_sway
}
trap finish EXIT
for _ in $(seq 50); do [ -S "$sock" ] && break; sleep 0.1; done

fails=0
check() { # what, then a command that must succeed
  local what=$1; shift
  if "$@"; then echo "  ok   $what"; else echo "  FAIL $what"; fails=$((fails + 1)); fi
}
api() { curl -sS --unix-socket "$sock" -X "$1" ${3:+-H 'Content-Type: application/json' -d "$3"} -o /dev/null -w '%{http_code}' "http://wadd$2"; }
view() { curl -sS --unix-socket "$sock" http://wadd/v1/view; }
until_view() { # substring
  for _ in $(seq 300); do view | grep -q "$1" && return 0; sleep 0.1; done
  echo "timed out waiting for $1: $(view)"; tail -5 "$dir/wadd.log"; return 1
}
active() { [ "$(systemctl --user is-active "wad-$1.service" 2>/dev/null)" = active ]; }
inactive() { for _ in $(seq 50); do active "$1" || return 0; sleep 0.1; done; return 1; }
shown_fullscreen() { # id app_id: its window, full screen on ws-<id>, focused
  for _ in $(seq 50); do where | grep -q "^ws-$1 fullscreen focused $2$" && return 0; sleep 0.1; done
  where; return 1
}
phase() { curl -sS --unix-socket "$sock" http://wadd/v1/states | python3 -c "import json,sys; print(next(s['phase'] for s in json.load(sys.stdin) if s['id']=='$1'))"; }
no_hotkeys() { ! curl -sS --unix-socket "$sock" http://wadd/v1/workspaces | grep -q '"hotkey":[0-9]'; }

echo "== sway is up"
until_view '"kind":"home"'
check "apps have no Super+number" no_hotkeys
check "no quadlet written for an app" bash -c "! ls '$XDG_RUNTIME_DIR'/containers/systemd/wad-terminal.container 2>/dev/null"

echo "== open the terminal"
t0=$(date +%s%N); api POST /v1/workspaces/terminal/switch >/dev/null
until_view '"id":"terminal"'; echo "  shown after $(( ($(date +%s%N) - t0) / 1000000 )) ms"
check "its transient unit runs" active terminal
check "full screen on ws-terminal" shown_fullscreen terminal foot

echo "== open WadBrowser"
t0=$(date +%s%N); api POST /v1/workspaces/browser/switch >/dev/null
until_view '"id":"browser"'; echo "  shown after $(( ($(date +%s%N) - t0) / 1000000 )) ms"
check "full screen on ws-browser" shown_fullscreen browser wadbrowser

echo "== a second WadBrowser window: on its space, and closing it leaves the browser open"
env XDG_RUNTIME_DIR="$rt" WAYLAND_DISPLAY=wayland-1 "$browser" --new-window >/dev/null 2>&1 || true
browser_windows() { where | grep -c "^ws-browser .* wadbrowser$" || true; }
for _ in $(seq 50); do [ "$(browser_windows)" = 2 ] && break; sleep 0.1; done
check "two windows on ws-browser" test "$(browser_windows)" = 2
check "the new one full screen" shown_fullscreen browser wadbrowser
newest=$(sm -t get_tree | python3 -c '
import json, sys
def walk(n):
    if n.get("app_id") == "wadbrowser": yield n["id"]
    for c in n.get("nodes", []) + n.get("floating_nodes", []): yield from walk(c)
print(max(walk(json.load(sys.stdin))))')
sm "[con_id=$newest] kill" || true
for _ in $(seq 50); do [ "$(browser_windows)" = 1 ] && break; sleep 0.1; done
check "one left" test "$(browser_windows)" = 1
check "still running, still the view" until_view '"id":"browser"'
check "the other full screen" shown_fullscreen browser wadbrowser
check "unit still up" active browser

echo "== Super+Tab (by API) goes back to the terminal"
api POST /v1/carousel/next >/dev/null; api POST /v1/carousel/commit >/dev/null
check "terminal on screen" until_view '"id":"terminal"'
check "terminal focused" shown_fullscreen terminal foot

echo "== restart the terminal: it comes back on screen"
api POST /v1/workspaces/terminal/restart >/dev/null
for _ in $(seq 100); do [ "$(phase terminal)" = ready ] && break; sleep 0.1; done
check "ready again" test "$(phase terminal)" = ready
check "still the view" until_view '"id":"terminal"'
check "full screen again" shown_fullscreen terminal foot

echo "== the terminal exits by itself (as \`exit\` would): off the screen, unit gone"
systemctl --user kill wad-terminal.service
check "back to WadSpaces Client" until_view '"kind":"home"'
check "unit gone" inactive terminal
for _ in $(seq 50); do [ "$(phase terminal)" = idle ] && break; sleep 0.1; done
check "stopped (idle)" test "$(phase terminal)" = idle

echo "== stop WadBrowser from the API"
check "stop answers" test "$(api POST /v1/workspaces/browser/stop)" = 200
check "unit gone" inactive browser
no_windows() { for _ in $(seq 50); do [ -z "$(where)" ] && return 0; sleep 0.1; done; where; return 1; }
check "no windows left" no_windows

echo "== wadd's log"
grep -E "window|ready|stopping|WARN|ERROR" "$dir/wadd.log" | tail -12
[ "$fails" = 0 ] && echo "PASS" || { echo "$fails FAILED"; exit 1; }
