#!/usr/bin/env bash
# Streams on this laptop (M11), as you: `wadd serve --user` streams a real
# native workspace (localhost/wadspaces-cosmic-bodybuilding) on the real
# `_stream` sidecar (localhost/wadspaces-stream:trixie), rootless.
#
#   apps/wadd/dev/try-stream.sh
#   VIEW=1 apps/wadd/dev/try-stream.sh   also Wad Creator's stream window
#                                        (WebKitGTK, in a virtual KWin), snapshotted
#
# Checks: refused until allowed and given a password; then the sidecar
# answers over TLS with wadd's certificate (the fingerprint /v1/streams
# reports), asks for the password on the page and the websocket, takes the
# right one (on the LAN address too), and a remote view (remote.rs) gets the
# page and the websocket through. Ending it brings everything down.
#
# Makes a random stream password as podman secret `stream_password` (refuses
# if you have one already) and removes it, and what it made, afterwards.
set -euo pipefail
ulimit -c 0
root=$(cd "$(dirname "$0")/../../.." && pwd)
dir=$root/.build/wadd-try-stream
sock=$dir/wadd.sock
port=47800
mkdir -p "$dir/state" "$dir/projects"
chmod 700 "$dir"

for img in localhost/wadspaces-cosmic-bodybuilding:latest localhost/wadspaces-stream:trixie; do
  podman image exists "$img" || { echo "needs $img (Wadspaces-David's build.sh)" >&2; exit 1; }
done
[ -S "$XDG_RUNTIME_DIR/podman/podman.sock" ] || { echo "needs podman.socket: systemctl --user start podman.socket" >&2; exit 1; }
if podman secret exists stream_password; then
  echo "you have a podman secret stream_password already; not touching it" >&2
  exit 1
fi

cat >"$dir/wadd.toml" <<TOML
[machine]
name = "wadd-try-stream"
[daemon]
socket = "$sock"
state_dir = "$dir/state"
projects_dir = "$dir/projects"
legacy_config = "$dir/none.yaml"
vendor_workspaces = "$dir/none.d"
ready_timeout_s = 120
[display]
enabled = false
[cloud]
enabled = false
TOML
cat >"$dir/state/workspaces.json" <<'JSON'
[{"id":"writing","name":"Writing","image":"localhost/wadspaces-cosmic-bodybuilding:latest","display":"host","port":null,
  "hotkey":1,"icon":null,"enabled":true,"autostart":false,"containerName":"wad-writing","containerPort":3000,
  "env":[["PUID","1000"],["PGID","1000"],["TZ","Pacific/Fiji"]],"secrets":[],"volumes":[],"devices":["/dev/dri"],
  "shmSize":"1g","projects":[]}]
JSON

(cd "$root" && cargo build -q -p wadd)
"$root/target/debug/wadd" serve --user --config "$dir/wadd.toml" >"$dir/wadd.log" 2>&1 &
pid=$!
pwfile=$dir/password
finish() {
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  systemctl --user stop wad-writing.service wad-writing-display.service 2>/dev/null || true
  rm -f "$XDG_RUNTIME_DIR"/containers/systemd/wad-writing*.container "$XDG_RUNTIME_DIR"/containers/systemd/wad-writing*.volume
  systemctl --user daemon-reload
  podman secret rm stream_password wad_stream_password >/dev/null 2>&1 || true
  podman volume rm -f wad-writing-display >/dev/null 2>&1 || true
  rm -f "$pwfile"
}
trap finish EXIT
for _ in $(seq 50); do [ -S "$sock" ] && break; sleep 0.1; done

api() { curl -sS --unix-socket "$sock" -X "$1" ${3:+-H 'content-type: application/json' -d "$3"} "http://wadd$2"; }
field() { python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1"; }

echo "== fails closed"
api POST /v1/workspaces/writing/stream | field 'd.get("message")'
api PUT /v1/streams/settings '{"allowRemote":true}' | field 'd["problem"]'
(umask 077 && head -c 24 /dev/urandom | base64 | tr -d '/+=\n' >"$pwfile")
printf 'short' | podman secret create stream_password - >/dev/null
api GET /v1/streams | field 'd["problem"]'
podman secret rm stream_password >/dev/null
podman secret create stream_password "$pwfile" >/dev/null
api GET /v1/streams | field '("password set:", d["passwordSet"], "problem:", d["problem"])'

echo "== streaming"
api POST /v1/workspaces/writing/stream '{}' >/dev/null
for _ in $(seq 120); do
  ready=$(api GET /v1/streams | field 'bool(d["streams"]) and d["streams"][0]["ready"]')
  [ "$ready" = True ] && break
  sleep 1
done
api GET /v1/streams | field '[(s["wsId"], s["port"], s["user"], s["urls"]) for s in d["streams"]]'
sha=$(api GET /v1/streams | field 'd["sha256"]')
user=$(api GET /v1/streams | field 'd["streams"][0]["user"]')
urls=$(api GET /v1/streams | field '",".join(d["streams"][0]["urls"])')
served=
for _ in $(seq 30); do # the port answers a moment before nginx's TLS does
  served=$(echo | openssl s_client -connect 127.0.0.1:$port 2>/dev/null | openssl x509 -outform der 2>/dev/null | sha256sum | cut -c1-64) || true
  [ "$served" != "$(printf '' | sha256sum | cut -c1-64)" ] && break
  sleep 1
done
echo "certificate served is the one reported: $([ "$served" = "$sha" ] && echo yes || echo "NO ($served)")"
pw=$(cat "$pwfile")
code() { curl -sk -o /dev/null -m 10 -w '%{http_code}' "$@"; }
ws=(-H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==')
echo "no password: page $(code https://127.0.0.1:$port/), websocket $(code "${ws[@]}" https://127.0.0.1:$port/websocket)"
echo "wrong one:   page $(code -u "$user:nope-nope-nope" https://127.0.0.1:$port/)"
echo "right one:   page $(code -u "$user:$pw" https://127.0.0.1:$port/), websocket $(code -u "$user:$pw" "${ws[@]}" https://127.0.0.1:$port/websocket)"
echo "plain http:  $(curl -s -o /dev/null -m 5 -w '%{http_code}' http://127.0.0.1:$port/ || true) (not HTTP: TLS only)"
lan=${urls%%,*}
[ -n "$lan" ] && echo "on the LAN ($lan): page $(code -u "$user:$pw" "$lan")"

echo "== a remote view of it (remote.rs)"
(cd "$root" && TRY_STREAM_URLS="$urls" TRY_STREAM_USER="$user" TRY_STREAM_SHA256="$sha" TRY_STREAM_PASSWORD_FILE="$pwfile" \
  cargo test -q -p wadd --test remote a_view_of_a_real_stream -- --ignored --nocapture 2>&1 | grep -E 'through a view|panicked|test result')

if [ -n "${VIEW:-}" ]; then
  echo "== in Wad Creator's stream window (WebKitGTK)"
  (cd "$root/apps/wadcreator" && npm run -s build:machine >/dev/null)
  (cd "$root" && cargo build -q -p wadcreator --features spike,custom-protocol)
  "$root/target/debug/wadd" view --url "https://127.0.0.1:$port/" --sha256 "$sha" --user "$user" \
    --password-file "$pwfile" >"$dir/view.url" 2>"$dir/view.log" &
  vpid=$!
  for _ in $(seq 50); do [ -s "$dir/view.url" ] && break; sleep 0.1; done
  rm -rf "$dir/spike"
  WADCREATOR_SPIKE_STREAM=$(head -1 "$dir/view.url") WADD_DAEMON=rs WADD_SOCKET=$sock \
    "$root/apps/wadcreator/src-tauri/spike/run.sh" "$dir/spike" | grep -E '^SPIKE (stream|snapshot)' | cut -c1-400
  kill "$vpid" 2>/dev/null || true
  echo "snapshot: $dir/spike/4-stream.png"
fi

echo "== ending it"
api DELETE /v1/workspaces/writing/stream | field '("streams:", d["streams"])'
sleep 2
echo "containers left: $(podman ps --format '{{.Names}}' | grep -c '^wad-writing' || true)"
echo "units now: $(ls "$XDG_RUNTIME_DIR"/containers/systemd/ | grep '^wad-writing' | tr '\n' ' ')"
api PUT /v1/streams/settings '{"allowRemote":false}' | field '("allowed:", d["allowRemote"])'
echo "== wadd's warnings"
grep -iE 'warn|error' "$dir/wadd.log" | tail -8 || true
