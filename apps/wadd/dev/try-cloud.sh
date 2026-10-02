#!/usr/bin/env bash
# Tries the Rust wadd's account link against the Firebase emulators (Auth,
# Firestore with the real firestore.rules, and the enrollMachine function):
# an owner signs up and makes a link code, wadd links with it, heartbeats,
# runs the owner's commands, syncs a project and a secret both ways, relinks
# (keeping its machine) and unlinks. Nothing touches the real project.
#
#   apps/wadd/dev/try-cloud.sh
#
# Needs Java (the Firestore emulator) and apps/wadcreator's npm packages.
set -euo pipefail
ulimit -c 0
root=$(cd "$(dirname "$0")/../../.." && pwd)
app=$root/apps/wadcreator

if [ -z "${TRY_CLOUD_INSIDE:-}" ]; then
  # The function's WEB_API_KEY, for the emulator only.
  made_secret=
  if [ ! -e "$app/functions/.secret.local" ]; then
    echo "WEB_API_KEY=fake-api-key" >"$app/functions/.secret.local"
    made_secret=1
  fi
  trap '[ -n "$made_secret" ] && rm -f "$app/functions/.secret.local"' EXIT
  (cd "$app" && npm --prefix functions run -s build)
  (cd "$root" && cargo build -q -p wadd)
  cd "$app"
  TRY_CLOUD_INSIDE=1 npx firebase emulators:exec --project demo-wadcreator --only auth,firestore,functions \
    "bash '$root/apps/wadd/dev/try-cloud.sh'" 2>&1 | grep -vE "^i  |^⚠  |^✔  |^\s*$|emulators:|functions\[|Debugger|^Running script"
  exit "${PIPESTATUS[0]}"
fi

# Inside the emulators.
P=demo-wadcreator
FS="http://127.0.0.1:8090/v1/projects/$P/databases/(default)/documents"
AUTH=http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1
dir=$root/.build/wadd-try-cloud
sock=$dir/wadd.sock
rm -rf "$dir"
mkdir -p "$dir/state" "$dir/projects"
echo '[]' >"$dir/state/workspaces.json"
j() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }

echo "== an owner signs up and makes a link code (as the web app does)"
owner=$(curl -sS "$AUTH/accounts:signUp?key=fake-api-key" -H 'Content-Type: application/json' \
  -d '{"email":"owner@example.com","password":"secret123","returnSecureToken":true}')
uid=$(j 'd["localId"]' <<<"$owner"); otok=$(j 'd["idToken"]' <<<"$owner")
as_owner() { curl -sS -X "$1" -H "Authorization: Bearer $otok" -H 'Content-Type: application/json' "$FS/$2" ${3:+-d "$3"}; }
code() { # a fresh link code
  local c=$1 now
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  as_owner PATCH "enrollCodes/$c" "{\"fields\":{\"uid\":{\"stringValue\":\"$uid\"},\"used\":{\"booleanValue\":false},\"createdAt\":{\"timestampValue\":\"$now\"},\"machineName\":{\"stringValue\":\"Laptop\"}}}" >/dev/null
}
code TRY001
echo "owner $uid; code TRY001"

cat >"$dir/wadd.toml" <<TOML
[machine]
name = "wadd-try-cloud"
[daemon]
socket = "$sock"
state_dir = "$dir/state"
projects_dir = "$dir/projects"
legacy_config = "$dir/none.yaml"
[display]
enabled = false
[cloud]
project_id = "$P"
api_key = "fake-api-key"
heartbeat_s = 5
poll_s = 1
emulator = "127.0.0.1"
TOML
"$root/target/debug/wadd" serve --user --config "$dir/wadd.toml" >"$dir/wadd.log" 2>&1 &
wadd_pid=$!
trap 'kill $wadd_pid 2>/dev/null; wait $wadd_pid 2>/dev/null; podman secret rm wadtry_secret >/dev/null 2>&1 || true' EXIT
for _ in $(seq 50); do [ -S "$sock" ] && break; sleep 0.1; done
api() { curl -sS --unix-socket "$sock" -X "$1" ${3:+-H 'Content-Type: application/json' -d "$3"} "http://wadd$2"; echo; }

echo "== wadd links with the code"
link=$(api POST /v1/cloud/link '{"code":"try001"}'); echo "$link"
mid=$(j 'd["machineId"]' <<<"$link")
echo "== its heartbeat, as the owner sees it (the rules let it through)"
for _ in $(seq 40); do
  hb=$(as_owner GET "users/$uid/machines/$mid")
  grep -q '"view"' <<<"$hb" && break
  sleep 0.5
done
j '{k: list(v.values())[0] for k, v in d["fields"].items() if k in ("view", "daemonVersion", "lastSeen", "name")}' <<<"$hb"
command() { # type [extra fields json]
  local id
  id=$(as_owner POST "users/$uid/machines/$mid/commands" "{\"fields\":{\"type\":{\"stringValue\":\"$1\"},\"status\":{\"stringValue\":\"pending\"}${2:-}}}" | j 'd["name"].rsplit("/",1)[1]')
  for _ in $(seq 40); do
    out=$(as_owner GET "users/$uid/machines/$mid/commands/$id")
    grep -q '"stringValue": "\(done\|error\)"' <<<"$out" && break
    sleep 0.5
  done
  j '(d["fields"]["status"]["stringValue"], json.dumps(d["fields"].get("result")))' <<<"$out"
}
echo "== the owner adds a project online and asks for a sync"
now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
as_owner PATCH "users/$uid/projects/p1" "{\"fields\":{\"name\":{\"stringValue\":\"Notes\"},\"mountName\":{\"stringValue\":\"Notes\"},\"source\":{\"mapValue\":{\"fields\":{\"kind\":{\"stringValue\":\"git\"},\"url\":{\"stringValue\":\"https://github.com/o/notes\"}}}},\"setup\":{\"stringValue\":\"\"},\"deleted\":{\"booleanValue\":false},\"createdAt\":{\"timestampValue\":\"$now\"},\"updatedAt\":{\"timestampValue\":\"$now\"}}}" >/dev/null
command projects-sync
api GET /v1/projects | j '[p["name"] for p in d]'
echo "== a project made on the machine goes up"
api PUT /v1/projects/p2 '{"name":"Here","mountName":"Here","source":{"kind":"git","url":"https://github.com/o/here"}}' >/dev/null
for _ in $(seq 40); do as_owner GET "users/$uid/projects/p2" | grep -q '"Here"' && break; sleep 0.5; done
as_owner GET "users/$uid/projects/p2" | j 'd["fields"]["name"]["stringValue"], d["fields"]["updatedAt"]'
echo "== a secret in the account comes to podman"
as_owner PATCH "users/$uid/secrets/wadtry_secret" '{"fields":{"value":{"stringValue":"from-the-account"}}}' >/dev/null
command sync-secrets
api GET /v1/secrets | j '[s for s in d if s["name"] == "wadtry_secret"]'
echo "== an unknown command can't even be queued (the rules)"
as_owner POST "users/$uid/machines/$mid/commands" '{"fields":{"type":{"stringValue":"teleport"},"status":{"stringValue":"pending"}}}' | j 'd["error"]["status"]' 
echo "== relinking to the same owner keeps the machine"
code TRY002
api POST /v1/cloud/link '{"code":"TRY002"}' | j 'd["machineId"], d["machineId"] == "'"$mid"'"'
echo "== unlink"
api DELETE /v1/cloud; api GET /v1/cloud
echo "== wadd's log"
grep -E "linked|warn|error" "$dir/wadd.log" | tail -6 || true
