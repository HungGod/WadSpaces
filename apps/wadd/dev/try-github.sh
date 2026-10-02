#!/usr/bin/env bash
# Tries the Rust wadd's GitHub on this laptop, as you, with the real GitHub:
#
#   apps/wadd/dev/try-github.sh             whose token podman has, and your repos (reads only)
#   apps/wadd/dev/try-github.sh --sign-in   the device sign-in first: enter the code it shows
#                                           (it replaces your podman github_token secret)
#
# The QR code goes to .build/wadd-try-github/qr.svg (open it, scan it).
set -euo pipefail
ulimit -c 0
root=$(cd "$(dirname "$0")/../../.." && pwd)
dir=$root/.build/wadd-try-github
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
[github]
app = "$root/host/usr/lib/wadspaces/github.toml"
TOML
(cd "$root" && cargo build -q -p wadd)
"$root/target/debug/wadd" serve --user --config "$dir/wadd.toml" >"$dir/wadd.log" 2>&1 &
wadd_pid=$!
trap 'kill $wadd_pid 2>/dev/null; wait $wadd_pid 2>/dev/null' EXIT
for _ in $(seq 50); do [ -S "$sock" ] && break; sleep 0.1; done
api() { curl -sS --unix-socket "$sock" -X "$1" "http://wadd$2"; echo; }
j() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }

if [ "${1:-}" = "--sign-in" ]; then
  echo "== sign in"
  s=$(api POST /v1/github/device)
  j 'd["code"]["userCode"] + "  at  " + d["code"]["verificationUri"]' <<<"$s"
  j 'd["qrSvg"]' <<<"$s" >"$dir/qr.svg"
  echo "(QR code: $dir/qr.svg)"
  for _ in $(seq 900); do
    st=$(api GET /v1/github | j '(d["signIn"] or {}).get("state")')
    [ "$st" != waiting ] && break
    sleep 1
  done
  api GET /v1/github | j 'd["signIn"]["state"], d["signIn"]["login"], d["signIn"]["error"]'
fi
echo "== whose token (refused: sign in again with --sign-in)"
api GET /v1/github | j 'd["token"], d["login"], d["error"]'
echo "== your repos (every page)"
t0=$(date +%s%N)
api GET /v1/github/repos | j 'd.get("message") or (str(len(d["repos"])) + " repos for " + d["login"] + ", newest: " + ", ".join(r["fullName"] for r in d["repos"][:5]))'
echo "  took $(( ($(date +%s%N) - t0) / 1000000 )) ms"
t0=$(date +%s%N)
api GET /v1/github/repos >/dev/null
echo "== again (from the last minute's): $(( ($(date +%s%N) - t0) / 1000000 )) ms"
