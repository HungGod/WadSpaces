#!/usr/bin/env bash
# The machine app against the Rust wadd (M9): `wadd serve --user` on a socket
# of its own, and the app's spike (src-tauri/spike/run.sh: the real UI in a
# virtual KWin, nothing on your desktop) talking to it with WADD_DAEMON=rs.
# Prints the spike's SPIKE lines and wadd's log; screenshots land in
# .build/wadd-try-app/spike.
#
#   apps/wadd/dev/try-app.sh
#
# Needs podman.socket, kwin_wayland and dbus-run-session. Builds the machine
# UI (npm run build:machine), the spike build of the app, and wadd.
set -euo pipefail
ulimit -c 0
root=$(cd "$(dirname "$0")/../../.." && pwd)
dir=$root/.build/wadd-try-app
sock=$dir/wadd.sock
rm -rf "$dir/spike"
mkdir -p "$dir/state" "$dir/projects" "$dir/spike"

cat >"$dir/wadd.toml" <<TOML
[machine]
name = "wadd-try-app"
[daemon]
socket = "$sock"
state_dir = "$dir/state"
projects_dir = "$dir/projects"
legacy_config = "$dir/none.yaml"
[keys]
enabled = false
TOML
echo '[{"id":"writing","name":"Writing","image":"localhost/wadspaces-test:latest","display":"host","enabled":true,"autostart":false,"containerName":"wad-writing","containerPort":3000,"env":[],"secrets":[],"volumes":[],"devices":[],"projects":[]}]' \
  >"$dir/state/workspaces.json"

(cd "$root/apps/wadcreator" && npm run -s build:machine >/dev/null)
(cd "$root" && cargo build -q -p wadd && cargo build -q -p wadcreator --features spike,custom-protocol)

"$root/target/debug/wadd" serve --user --config "$dir/wadd.toml" >"$dir/wadd.log" 2>&1 &
pid=$!
finish() {
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  rm -f "$XDG_RUNTIME_DIR"/containers/systemd/wad-writing.container
  systemctl --user daemon-reload
}
trap finish EXIT
for _ in $(seq 50); do [ -S "$sock" ] && break; sleep 0.1; done

# WADD_URL points nowhere: every call must go to the Rust wadd.
WADD_DAEMON=rs WADD_SOCKET=$sock WADD_URL=http://127.0.0.1:9 \
  "$root/apps/wadcreator/src-tauri/spike/run.sh" "$dir/spike"
echo "== the app's log"
grep -i 'wadd' "$dir/spike/app.log" | grep -v '^SPIKE' | tail -5
echo "== wadd's warnings"
grep -iE 'warn|error' "$dir/wadd.log" | tail -10 || true
