#!/bin/bash
# The clipboard bridge between two headless sways, standing in for the
# machine's sway and a wadspace's labwc (both speak wlr-data-control). Uses
# wl-clipboard (wl-copy, wl-paste) as the apps. Nothing shows on your desktop.
#
#   crates/wad-clip/dev/try.sh
#
# Then the HUD's half (if apps/hud builds here): on the "machine", it keeps a
# copy alive when its app goes.
set -euo pipefail
root=$(cd "$(dirname "$0")/../../.." && pwd)
cd "$root"
cargo build -q -p wad-clip -p wadspaces-hud --examples
bridge=$root/target/debug/wadspaces-clipboard
work=$(mktemp -d "${TMPDIR:-/tmp}/wadclip.XXXXXX")

if command -v sway >/dev/null; then sway=sway; libs=; else sway=$root/.build/sway/usr/bin/sway; libs=$root/.build/sway/usr/lib64; fi
pids=()
cleanup() { kill "${pids[@]}" 2>/dev/null || true; wait 2>/dev/null || true; rm -rf "$XDG_RUNTIME_DIR"/wadclip-{machine,here} "$work"; }
trap cleanup EXIT

# start <name>: a headless sway; its Wayland socket in $socket.
start() {
  local rt=$XDG_RUNTIME_DIR/wadclip-$1
  rm -rf "$rt"; mkdir -m 700 "$rt"
  echo 'output HEADLESS-1 resolution 800x600' >"$work/$1.conf"
  env -u WAYLAND_DISPLAY -u DISPLAY XDG_RUNTIME_DIR="$rt" WLR_BACKENDS=headless WLR_RENDERER=pixman \
    WLR_LIBINPUT_NO_DEVICES=1 ${libs:+LD_LIBRARY_PATH=$libs} "$sway" -c "$work/$1.conf" >"$work/$1.log" 2>&1 &
  pids+=($!)
  for _ in $(seq 50); do [ -S "$rt/wayland-1" ] && break; sleep 0.1; done
  socket=$rt/wayland-1
}
start machine; machine=$socket
start here; here=$socket
on() { local d=$1; shift; WAYLAND_DISPLAY=$d "$@"; }

WAYLAND_DISPLAY=$here "$bridge" --host "$machine" 2>"$work/bridge.log" &
bridge_pid=$!
pids+=($bridge_pid)
sleep 0.5

fail=0
check() { # check <what> <want> <got>
  if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: wanted [$2], got [$3]"; fail=1; fi
}
paste() { on "$1" timeout 5 wl-paste -n 2>/dev/null || true; }

on "$here" wl-copy "copied in the wadspace"
sleep 0.5
check "wadspace -> machine" "copied in the wadspace" "$(paste "$machine")"

on "$machine" wl-copy "copied on the machine"
sleep 0.5
check "machine -> wadspace" "copied on the machine" "$(paste "$here")"

# The copying app goes away: the machine still has it (the bridge serves it).
on "$here" wl-copy --foreground "short-lived" & copier=$!
sleep 0.5
kill $copier; sleep 0.3
check "outlives its app" "short-lived" "$(paste "$machine")"

# An image, whole.
python3 -c 'import os,sys; sys.stdout.buffer.write(b"\x89PNG\r\n\x1a\n" + os.urandom(3 << 20))' >"$work/in.png"
on "$here" wl-copy --type image/png <"$work/in.png"
sleep 1
on "$machine" timeout 5 wl-paste --type image/png >"$work/out.png" 2>/dev/null || true
check "a 3 MB image" "$(sha256sum <"$work/in.png")" "$(sha256sum <"$work/out.png")"
types=$(on "$machine" wl-paste --list-types | grep -v '^application/x-wadspaces-from-' | tr '\n' ' ')
check "its types (and the bridge's marker)" "image/png " "$types"

# Nothing goes round: one copy, still there after a while, and the bridge
# didn't copy it back (the wadspace's selection is still wl-copy's).
on "$here" wl-copy "once"
sleep 1
check "no echo" "0" "$(on "$here" wl-paste --list-types | grep -c '^application/x-wadspaces-from-')"
check "still there" "once" "$(paste "$machine")"
kill -0 "$bridge_pid" 2>/dev/null && echo "ok   bridge alive" || { echo "FAIL bridge died"; fail=1; }

# The HUD on the machine's sway: an app's copy outlives the app.
env -u DISPLAY WAYLAND_DISPLAY=$machine GDK_BACKEND=wayland GTK_A11Y=none WADD_SOCKET=$work/no-wadd.sock \
  XDG_CONFIG_HOME=$work/config dbus-run-session -- "$root/target/debug/wadspaces-hud" >"$work/hud.log" 2>&1 &
pids+=($!)
sleep 2
on "$machine" wl-copy --foreground "kept by the HUD" & copier=$!
sleep 0.5
kill $copier; sleep 0.5
check "the HUD keeps it" "kept by the HUD" "$(paste "$machine")"
check "and the wadspace gets it" "kept by the HUD" "$(paste "$here")"

# A password manager in the wadspace: its copy pastes on the machine, and
# when it clears its copy (its timeout), it's gone everywhere, the HUD
# keeping nothing.
"$root/target/debug/examples/password-manager" "$here" "hunter2" 1.5 & pm=$!
sleep 0.7
check "a password travels" "hunter2" "$(paste "$machine")"
wait $pm
sleep 0.5
check "and is cleared everywhere" "" "$(paste "$machine")"
check "here too" "" "$(paste "$here")"
grep -i "clipboard" "$work/hud.log" | sed 's/^/     hud: /' || true

sed 's/^/     bridge: /' "$work/bridge.log"
exit $fail
