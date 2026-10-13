#!/usr/bin/env bash
# The Builder's layers for real, on this laptop, as you: wadd (with your
# rootless podman) builds an Extensions layer on the Dev template (WadBrowser
# and VS Code), which builds the template first; then a template built on
# Dev (adding Tiled), which builds on Dev's image without building Dev again;
# the images are listed with their labels; a wadspace (a stack) is installed
# on the Extensions with a wallpaper given at run time, and opened in a
# headless sway (desktop.png: its icons, the wallpaper, the Start button's
# logo); VS Code's extension is in its home; then a throwaway run of it is
# launched, stopped, and gone.
#
#   apps/wadd/dev/try-layers.sh
#   KEEP=1 apps/wadd/dev/try-layers.sh     leave the images
#
# Needs localhost/wadspaces-base:trixie (images/build.sh --only base) and sway
# (see sway.sh). The workspaces and units are removed afterwards.
set -euo pipefail
ulimit -c 0
root=$(cd "$(dirname "$0")/../../.." && pwd)
dir=$root/.build/wadd-try-layers
sock=$dir/wadd.sock
rm -rf "$dir"
mkdir -p "$dir/state" "$dir/projects" "$dir/signins"
podman image exists localhost/wadspaces-base:trixie || { echo "no base: images/build.sh --only base" >&2; exit 1; }
[ -S "$XDG_RUNTIME_DIR/podman/podman.sock" ] || systemctl --user start podman.socket
. "$root/apps/wadd/dev/sway.sh"
start_sway "$dir"

cat >"$dir/wadd.toml" <<TOML
[machine]
name = "wadd-try-layers"
[daemon]
socket = "$sock"
state_dir = "$dir/state"
projects_dir = "$dir/projects"
signins_dir = "$dir/signins"
vendor_workspaces = "$dir/none.d"
ready_timeout_s = 240
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
  for u in "$XDG_RUNTIME_DIR"/containers/systemd/wad-tryl*.container; do
    [ -e "$u" ] || continue
    systemctl --user stop "$(basename "$u" .container).service" 2>/dev/null || true
    rm -f "$u"
  done
  systemctl --user daemon-reload
  if [ -z "${KEEP:-}" ]; then
    podman rmi -i localhost/wadspaces-custom-tryl-plus:latest localhost/wadspaces-template-tryl-more:latest \
      localhost/wadspaces-template-tryl-dev:latest >/dev/null 2>&1 || true
  fi
  stop_sway
}
trap finish EXIT
for _ in $(seq 50); do [ -S "$sock" ] && break; sleep 0.1; done
api() { curl -sS --unix-socket "$sock" -X "$1" "http://wadd$2"; echo; }
send() { curl -sS --unix-socket "$sock" -X "$1" -H 'Content-Type: application/json' --data-binary @- "http://wadd$2"; echo; }
fail() { echo "FAILED: $*"; grep -E "warn|error" "$dir/wadd.log" | tail -5; exit 1; }

template='{"id":"tryl-dev","owner":"me","name":"Try Dev","description":"","apps":["wadbrowser","vscode"],"createdAt":"t","updatedAt":"t"}'
custom='{"id":"tryl-plus","owner":"me","name":"Try Dev plus","description":"","templateId":"tryl-dev","browserMode":"browser",
  "webapps":[{"id":"github","name":"GitHub","url":"https://github.com"}],"extensions":["esbenp.prettier-vscode"],
  "tools":["go"],"autostart":[],"createdAt":"t","updatedAt":"t"}'

# A build to its end; its result and its » / ✓ / ✗ lines.
build() {
  local id out
  id=$(send POST /v1/images/build |
    python3 -I -c 'import json,sys; d=json.load(sys.stdin); print(d.get("id") or sys.exit(str(d)))')
  for _ in $(seq 7200); do
    out=$(curl -sS --unix-socket "$sock" "http://wadd/v1/builds/$id")
    grep -q '"status":"\(done\|error\|cancelled\)"' <<<"$out" && break
    sleep 0.5
  done
  python3 -I -c '
import json, sys
l = json.load(sys.stdin); b = l["build"]
print("status:", b["status"], b["error"] or "", "| layer:", b["layer"], "| progress:", round(b["progress"], 2))
for line in l["lines"]:
    if line.startswith(("»", "✓", "✗", "STEP")): print("  |", line[:110])' <<<"$out" | tee "$dir/last-build.txt"
  grep -q '"status":"done"' <<<"$out" || fail "the build failed"
}

echo "== build the Extensions (its template first)"
t0=$(date +%s)
printf '{"layer":"custom:tryl-plus","template":%s,"extensions":%s}' "$template" "$custom" | build
echo "  took $(( $(date +%s) - t0 )) s"

echo "== a template built on it: Try Dev plus Tiled"
more='{"id":"tryl-more","owner":"me","name":"Try More","description":"","parent":"tryl-dev","apps":["wadbrowser","vscode","tiled"],"createdAt":"t","updatedAt":"t"}'
t0=$(date +%s)
printf '{"layer":"template:tryl-more","template":%s,"parents":[%s]}' "$more" "$template" | build
echo "  took $(( $(date +%s) - t0 )) s"
grep -q "the Try Dev template is built already" "$dir/last-build.txt" || fail "Try Dev was built again"
dev_id=$(podman image inspect -f '{{.Id}}' localhost/wadspaces-template-tryl-dev:latest)
more_from=$(podman image inspect -f '{{index .Labels "io.wadspaces.from"}}' localhost/wadspaces-template-tryl-more:latest)
[ "$dev_id" = "$more_from" ] || fail "Try More isn't built on Try Dev's image ($more_from)"
podman run --rm --entrypoint sh localhost/wadspaces-template-tryl-more:latest -c \
  'command -v code >/dev/null && command -v tiled >/dev/null && echo "  VS Code (from Try Dev) and Tiled are both in it"' ||
  fail "Try More is missing an app"

echo "== the layer images"
api GET /v1/images | python3 -I -c '
import json, sys
for r in json.load(sys.stdin): print("  ", r["layer"], r["ref"], r["dockerfileSha"][:12], "from", r["from"][:12], r["sizeMb"], "MB")'

echo "== install a wadspace (a stack) on the Extensions, with a wallpaper at run time"
wadspace='{"version":3,"id":"tryl-space","owner":"me","order":1,"template":"tryl-dev","extensions":"tryl-plus",
  "customization":{"name":"Try space","description":"","wallpaper":{"type":"color","value":"#205080"},"projects":[],"secrets":{"bySlot":{}}},
  "createdAt":"t","updatedAt":"t"}'
# A WadSpaces-made wallpaper: a PNG of one colour.
png=$(python3 -I -c '
import base64, struct, zlib
w, h = 64, 40
raw = b"".join(b"\0" + bytes([0x20, 0x50, 0x80]) * w for _ in range(h))
def chunk(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")
print(base64.b64encode(png).decode())')
printf '{"wadspace":%s,"template":%s,"extensions":%s,"tz":"Pacific/Fiji"}' "$wadspace" "$template" "$custom" |
  send PUT /v1/wadspaces/tryl-space | python3 -I -c 'import json,sys; d=json.load(sys.stdin); w=d.get("workspace") or sys.exit(str(d)); print("  ", w["image"], [e for e in w["env"] if e[0].startswith("WALL")])'
printf '{"ext":"png","data":"%s"}' "$png" | send PUT /v1/workspaces/tryl-space/wallpaper >/dev/null
[ -f "$dir/state/extra/tryl-space/wallpaper.png" ] || fail "no wallpaper in the extra folder"
# Its desktop draws on the headless sway, not your session's display (as
# the other trials' workspaces do): WADSPACES_WAYLAND names that socket.
api GET /v1/workspaces/tryl-space | python3 -I -c '
import json, sys
w = json.load(sys.stdin)
w["env"] = [e for e in w["env"] if e[0] != "WADSPACES_WAYLAND"] + [["WADSPACES_WAYLAND", sys.argv[1] + "/wayland-1"]]
print(json.dumps(w))' "$rt_name" | send PUT /v1/workspaces/tryl-space >/dev/null

echo "== open it"
printf '{"kind":"workspace","workspace":"tryl-space","projects":[]}' | send POST /v1/launches >/dev/null
for _ in $(seq 480); do api GET /v1/view | grep -q '"id":"tryl-space"' && break; sleep 0.5; done
api GET /v1/view; where
sleep 8
grim_bin=$(command -v grim || echo "$root/.build/sway/usr/bin/grim")
env XDG_RUNTIME_DIR="$rt" WAYLAND_DISPLAY=wayland-1 ${libs:+LD_LIBRARY_PATH=$libs} "$grim_bin" "$dir/desktop.png" &&
  echo "  desktop: $dir/desktop.png"
podman exec -u abc wad-tryl-space sh -c '
  echo "  extensions: $(ls ~/.vscode/extensions | grep -v json | tr "\n" " ")"
  echo "  desktop: $(ls ~/Desktop | tr "\n" " ")"
  echo "  go: $(go version 2>&1)"
  echo "  WALLPAPER=$WALLPAPER"' || fail "can't look inside"

echo "== a throwaway run of it, stopped: gone"
run=$(printf '{"kind":"run","from":"tryl-space","overrides":{"projects":[]}}' | send POST /v1/launches |
  python3 -I -c 'import json,sys; d=json.load(sys.stdin); print(d.get("wsId") or sys.exit(str(d)))')
echo "  $run"
for _ in $(seq 240); do api GET "/v1/workspaces/$run/state" | grep -q '"phase":"ready"' && break; sleep 0.5; done
api POST "/v1/workspaces/$run/stop" >/dev/null
for _ in $(seq 120); do grep -q "$run, run once, stopped: removed" "$dir/wadd.log" && break; sleep 0.5; done
api GET /v1/workspaces | grep -q "\"$run\"" && fail "the run is still listed"
[ -e "$dir/state/extra/$run" ] && fail "the run's extra folder is still there"
echo "  gone"
api POST /v1/workspaces/tryl-space/stop >/dev/null
api DELETE /v1/workspaces/tryl-space >/dev/null
echo ok
