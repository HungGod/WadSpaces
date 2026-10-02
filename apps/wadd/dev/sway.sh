# Sourced by the try-*.sh scripts: a headless sway with the machine's sway
# rules (no window on your desktop), its runtime dir under yours because a
# native workspace mounts $XDG_RUNTIME_DIR and finds this socket through
# WADSPACES_WAYLAND=$rt_name/wayland-1.
#
#   start_sway <dir>   sets rt_name, rt, ipc, sway_pid; sm (swaymsg) works after
#   stop_sway
#   focused            the focused sway workspace
#   where              each window: its sway workspace, fullscreen?, focused?, app_id
#
# Uses sway if it's installed, else one unpacked under .build/sway (no root):
#   mkdir -p .build/sway && cd .build/sway
#   dnf download sway sway-config-upstream wlroots libseat libliftoff xcb-util-errors
#   for r in *.rpm; do rpm2cpio "$r" | cpio -idm; done

rt_name=wadd-try-sway
rt=$XDG_RUNTIME_DIR/$rt_name

start_sway() {
  local dir=$1 root sway libs_dir
  root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
  if command -v sway >/dev/null; then sway=sway; swaymsg=swaymsg; libs=
  else sway=$root/.build/sway/usr/bin/sway; swaymsg=$root/.build/sway/usr/bin/swaymsg; libs=$root/.build/sway/usr/lib64; fi
  rm -rf "$rt"
  mkdir -m 700 "$rt"
  { grep -v '^exec ' "$root/host/etc/sway/wadspaces.conf"; echo 'output HEADLESS-1 resolution 1280x800'; } >"$dir/sway.conf"
  env -u WAYLAND_DISPLAY -u DISPLAY XDG_RUNTIME_DIR="$rt" WLR_BACKENDS=headless WLR_RENDERER=pixman \
    WLR_LIBINPUT_NO_DEVICES=1 ${libs:+LD_LIBRARY_PATH=$libs} "$sway" -c "$dir/sway.conf" >"$dir/sway.log" 2>&1 &
  sway_pid=$!
  for _ in $(seq 50); do ls "$rt"/sway-ipc.*.sock >/dev/null 2>&1 && [ -S "$rt/wayland-1" ] && break; sleep 0.1; done
  ipc=$(ls "$rt"/sway-ipc.*.sock)
}

stop_sway() {
  kill "$sway_pid" 2>/dev/null || true
  wait "$sway_pid" 2>/dev/null || true
  rm -rf "$rt"
}

sm() { env ${libs:+LD_LIBRARY_PATH=$libs} "$swaymsg" -s "$ipc" "$@"; }

focused() { sm -t get_workspaces | python3 -c 'import json,sys; print(next(w["name"] for w in json.load(sys.stdin) if w["focused"]))'; }

where() {
  sm -t get_tree | python3 -c '
import json, sys
def walk(n, ws=None):
    if n.get("type") == "workspace": ws = n["name"]
    if n.get("pid") and n.get("type") in ("con", "floating_con"):
        print(ws, "fullscreen" if n.get("fullscreen_mode") else "tiled", "focused" if n.get("focused") else "", n.get("app_id"))
    for c in n.get("nodes", []) + n.get("floating_nodes", []): walk(c, ws)
walk(json.load(sys.stdin))'
}
