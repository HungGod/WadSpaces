#!/usr/bin/env bash
# Tries the Rust wadd's network with the real NetworkManager, as you:
#
#   apps/wadd/dev/try-network.sh                       status and networks in range (reads only)
#   apps/wadd/dev/try-network.sh --join SSID           join (asks the password; a saved one joins without)
#   apps/wadd/dev/try-network.sh --forget SSID         forget a saved network
#
# Joining moves this laptop to that network; on a laptop NetworkManager may
# ask polkit for permission (a machine's wadd is root and isn't asked).
set -euo pipefail
ulimit -c 0
root=$(cd "$(dirname "$0")/../../.." && pwd)
dir=$root/.build/wadd-try-network
sock=$dir/wadd.sock
rm -rf "$dir"
mkdir -p "$dir/state"
echo '[]' >"$dir/state/workspaces.json"
cat >"$dir/wadd.toml" <<TOML
[daemon]
socket = "$sock"
state_dir = "$dir/state"
projects_dir = "$dir/projects"
legacy_config = "$dir/none.yaml"
[display]
enabled = false
[cloud]
enabled = false
TOML
(cd "$root" && cargo build -q -p wadd)
"$root/target/debug/wadd" serve --user --config "$dir/wadd.toml" >"$dir/wadd.log" 2>&1 &
wadd_pid=$!
trap 'kill $wadd_pid 2>/dev/null; wait $wadd_pid 2>/dev/null' EXIT
for _ in $(seq 50); do [ -S "$sock" ] && break; sleep 0.1; done
api() { curl -sS --unix-socket "$sock" -X "$1" ${3:+-H 'Content-Type: application/json' --data-binary @-} "http://wadd$2" ${3:+<<<"$3"}; echo; }
post() { curl -sS --unix-socket "$sock" -X POST -H 'Content-Type: application/json' --data-binary @- "http://wadd$1"; echo; }

case "${1:-}" in
  --join)
    read -r -s -p "password for $2 (empty: saved or open): " pw; echo
    python3 -c 'import json,sys; print(json.dumps({"ssid": sys.argv[1], "password": sys.argv[2] or None}))' "$2" "$pw" | post /v1/network/wifi/connect ;;
  --forget)
    python3 -c 'import json,sys; print(json.dumps({"ssid": sys.argv[1]}))' "$2" | post /v1/network/wifi/forget ;;
esac
echo "== status"
api GET /v1/network
echo "== networks in range"
show() {
  python3 /dev/fd/3 3<<'PY'
import json, sys
for n in json.load(sys.stdin):
    star = "*" if n["active"] else " "
    saved = "saved" if n["known"] else "     "
    note = "" if n["supported"] else "(not joinable here) "
    print(f"{n['signal']:>3} {n['security']:<12} {star} {saved} {note}{n['ssid']}")
PY
}
curl -sS --unix-socket "$sock" "http://wadd/v1/network/wifi?rescan=true" | show
