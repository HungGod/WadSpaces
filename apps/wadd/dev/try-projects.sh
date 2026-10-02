#!/usr/bin/env bash
# Tries the Rust wadd's projects on this laptop, as you: a GitHub repo
# (cloned for real: a tiny public one), a folder, and a drive (a disk image
# attached as a loop device with udisksctl, as a USB stick would appear),
# launched together into the busybox test workspace.
#
#   apps/wadd/dev/try-projects.sh
#
# Needs podman.socket and udisks (both there on a Fedora desktop). Nothing
# needs root; everything is removed afterwards.
set -euo pipefail
ulimit -c 0
root=$(cd "$(dirname "$0")/../../.." && pwd)
dir=$root/.build/wadd-try-projects
sock=$dir/wadd.sock
port=3197
rm -rf "$dir"
mkdir -p "$dir/state" "$dir/projects" "$dir/home/Notes" "$dir/stick-files/Books/Novel"
echo "my notes" >"$dir/home/Notes/todo.md"
echo "chapter one" >"$dir/stick-files/Books/Novel/one.md"

podman image exists localhost/wadspaces-test:latest &&
  [ "$(podman image inspect localhost/wadspaces-test:latest --format '{{index .Labels "io.wadspaces.projects"}}')" = 1 ] ||
  podman build -q -t localhost/wadspaces-test:latest "$root/apps/wadd/dev/test-image" >/dev/null

# The "stick": a 64 MB disk with one ext4 partition holding Books/.
img=$dir/stick.img
truncate -s 64M "$img"
echo 'start=2048, type=83' | sfdisk -q "$img"
mkfs.ext4 -q -F -L WADTRY -d "$dir/stick-files" -E offset=$((2048 * 512)) "$img" 63M
loop=$(udisksctl loop-setup -f "$img" --no-user-interaction | sed -n 's/.* as \(\/dev\/loop[0-9]*\)\.$/\1/p')
for _ in $(seq 50); do [ -e "${loop}p1" ] && break; sleep 0.1; done
uuid=$(lsblk -no UUID "${loop}p1")
echo "== the stick: ${loop}p1 ($uuid)"

cat >"$dir/wadd.toml" <<TOML
[machine]
name = "wadd-try-projects"
[daemon]
socket = "$sock"
state_dir = "$dir/state"
projects_dir = "$dir/projects"
legacy_config = "$dir/none.yaml"
ready_timeout_s = 60
[display]
enabled = false
TOML
cat >"$dir/state/workspaces.json" <<JSON
[{"id":"tryprojects","name":"Try projects","image":"localhost/wadspaces-test:latest","display":"stream","port":$port,
  "enabled":true,"autostart":false,"containerName":"wad-tryprojects","containerPort":3000,
  "env":[],"secrets":[],"volumes":[],"devices":[],"projects":[]}]
JSON

(cd "$root" && cargo build -q -p wadd)
"$root/target/debug/wadd" serve --user --config "$dir/wadd.toml" >"$dir/wadd.log" 2>&1 &
wadd_pid=$!
finish() {
  kill "$wadd_pid" 2>/dev/null || true
  wait "$wadd_pid" 2>/dev/null || true
  systemctl --user stop wad-tryprojects.service 2>/dev/null || true
  rm -f "$XDG_RUNTIME_DIR"/containers/systemd/wad-tryprojects.container
  systemctl --user daemon-reload
  udisksctl unmount -b "${loop}p1" --no-user-interaction >/dev/null 2>&1 || true
  udisksctl loop-delete -b "$loop" --no-user-interaction >/dev/null 2>&1 || true
}
trap finish EXIT
for _ in $(seq 50); do [ -S "$sock" ] && break; sleep 0.1; done

api() { curl -sS --unix-socket "$sock" -X "$1" ${3:+-H 'Content-Type: application/json' -d "$3"} "http://wadd$2"; echo; }
field() { python3 -c "import json,sys; print(json.load(sys.stdin)$1)"; }

echo "== drives (the stick is listed; the laptop's own disk isn't)"
api GET /v1/drives | python3 -c 'import json,sys; [print(" ", d["label"], d["fstype"], d["uuid"], d["mountpoint"]) for d in json.load(sys.stdin)]'
echo "== browsing the stick (it gets mounted)"
api GET "/v1/browse?drive=$uuid"
echo "== three projects"
api PUT /v1/projects/hello '{"name":"Hello World","mountName":"HelloWorld","source":{"kind":"git","url":"https://github.com/octocat/Hello-World"}}' | field '["source"]'
api PUT /v1/projects/notes "{\"name\":\"Notes\",\"mountName\":\"Notes\",\"source\":{\"kind\":\"folder\",\"path\":\"$dir/home/Notes\"}}" | field '["source"]'
api PUT /v1/projects/novel "{\"name\":\"Novel\",\"mountName\":\"Novel\",\"source\":{\"kind\":\"drive\",\"uuid\":\"$uuid\",\"label\":\"WADTRY\",\"fstype\":\"ext4\",\"subpath\":\"Books/Novel\"}}" | field '["source"]'
launch() { # projects as JSON list, restart
  id=$(api POST /v1/launches "{\"workspace\":\"tryprojects\",\"projects\":$1,\"restart\":${2:-false}}" | field '["id"]')
  for _ in $(seq 600); do
    out=$(api GET "/v1/launches/$id")
    echo "$out" | grep -q '"status":"\(done\|error\|cancelled\)"' && break
    sleep 0.1
  done
  echo "$out" | python3 -c '
import json, sys
l = json.load(sys.stdin)
print("status:", l["launch"]["status"], l["launch"]["error"] or "")
for p in l["launch"]["parts"]: print("  part", p["key"], p["state"], p["message"])
for line in l["lines"]: print("  |", line)'
}
echo "== launch with all three"
t0=$(date +%s%N); launch '["hello","notes","novel"]'; echo "took $(( ($(date +%s%N) - t0) / 1000000 )) ms"
echo "== inside the workspace"
podman exec wad-tryprojects ls /config/Desktop
podman exec wad-tryprojects cat /config/Desktop/Notes/todo.md /config/Desktop/Novel/one.md /config/Desktop/HelloWorld/README
podman exec wad-tryprojects cat /run/wadspaces-extra/projects.json | head -5
echo "== status"
for p in hello notes novel; do api GET "/v1/projects/$p/status"; done
echo "== again with one project less: refused while it runs, unless restart"
api POST /v1/launches '{"workspace":"tryprojects","projects":["hello","notes"]}'
launch '["hello","notes"]' true | grep -E "status|part hello|stopping|now mounts"
echo "== and again, unchanged: the clone is fetched, nothing restarts"
launch '["hello","notes"]' | grep -E "status|part hello|up to date|stopping"
podman exec wad-tryprojects ls /config/Desktop
echo "== purge refused while mounted"
api DELETE '/v1/projects/hello?purge=true'
echo "== wadd's log"
grep -iE "warn|error" "$dir/wadd.log" | tail -5 || true
