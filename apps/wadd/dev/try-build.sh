#!/usr/bin/env bash
# Tries the Rust wadd's builds on this laptop, as you: a design (as Wad
# Creator sends it) is made into a build folder by wad-core, built by your
# rootless podman on the lean base, added as a workspace, and opened in a
# headless sway; then built again (an update: the cache makes it quick).
#
#   apps/wadd/dev/try-build.sh
#
# Needs localhost/wadspaces-base:trixie (../Wadspaces-David/build.sh --only
# _common) and sway (see sway.sh). The image and units are removed afterwards.
set -euo pipefail
ulimit -c 0
root=$(cd "$(dirname "$0")/../../.." && pwd)
dir=$root/.build/wadd-try-build
sock=$dir/wadd.sock
rm -rf "$dir"
mkdir -p "$dir/state" "$dir/projects"
podman image exists localhost/wadspaces-base:trixie || { echo "no localhost/wadspaces-base:trixie: build it in Wadspaces-David first" >&2; exit 1; }
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
design = {"id": "trybuild", "name": sys.argv[1], "description": "",
  "layout": {"wallpaper": {"type": "color", "value": "#203040"}, "icons": [], "grid": True},
  "advanced": {"display": "host", "port": None, "hotkey": 2, "tools": [], "projects": [], "kaleResources": [],
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
}

echo "== build a design"
build "Try build"
api GET /v1/workspaces/trybuild
echo "== open it: its desktop's window in sway"
api POST /v1/workspaces/trybuild/switch >/dev/null
for _ in $(seq 600); do view | grep -q '"id":"trybuild"' && break; sleep 0.2; done
view; echo; where; echo "focused workspace: $(focused)"
echo "== build it again, renamed (an update; it's running, so it needs a restart)"
build "Try build 2"
api GET /v1/workspaces/trybuild | grep -o '"name":"[^"]*"'
echo "== wadd's log"
grep -E "warn|error|ready|window" "$dir/wadd.log" | tail -6 || true
