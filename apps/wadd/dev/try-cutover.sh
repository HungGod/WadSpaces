#!/usr/bin/env bash
# The cutover's first boot, rehearsed in a container (M10): the host image
# (host/build.sh image) booted with systemd, on top of what a Python-wadd
# machine had: its workspaces.yaml (stale: wad-c still streamed), the units
# it generated in /etc/containers/systemd (and one made by hand), and
# seeded-secrets.json. Then: did wadd.socket and wadd.service come up, did
# `wadd migrate` do its three things, may the kiosk user use the socket (and
# a stranger not)?
#
#   apps/wadd/dev/try-cutover.sh        (after host/build.sh image)
#
# No sway, greetd or podman containers in here: wadd runs without a screen,
# and podman inside a rootless container may not start workspaces.
set -euo pipefail
ulimit -c 0
root=$(cd "$(dirname "$0")/../../.." && pwd)
dir=$root/.build/try-cutover
name=wadd-cutover
rm -rf "$dir" && mkdir -p "$dir/units" "$dir/state"

python3 -c '
import sys, yaml
d = yaml.safe_load(sys.stdin)
for w in d["workspaces"]:
    if w["id"] == "wad-c":
        w["display"] = "stream"; w["port"] = 3102
yaml.safe_dump(d, sys.stdout, sort_keys=False)' <"$root/legacy/wadd-py/host/workspaces.yaml" >"$dir/workspaces.yaml"
cp "$root/fixtures/quadlet/wad-writing.container" "$dir/units/"
printf '[Container]\nImage=localhost/handmade\n' >"$dir/units/wad-handmade.container"
printf '{"github_token": "%s"}' "$(printf 'ghp_baked\n' | sha256sum | cut -c1-64)" >"$dir/state/seeded-secrets.json"

cat >"$dir/Containerfile" <<'EOF'
FROM localhost/wadspaces-host:latest
# No screen here.
RUN systemctl mask greetd.service && \
    useradd -m stranger
COPY workspaces.yaml /etc/wadspaces/workspaces.yaml
COPY units/ /etc/containers/systemd/
COPY state/ /var/lib/wadspaces/
EOF
podman build -q -t localhost/wadd-cutover-try "$dir" >/dev/null

podman rm -f "$name" >/dev/null 2>&1 || true
podman run -d --name "$name" --systemd=always localhost/wadd-cutover-try /sbin/init >/dev/null
trap 'podman rm -f "$name" >/dev/null 2>&1 || true' EXIT
ex() { podman exec "$name" "$@"; }
for _ in $(seq 60); do
  st=$(ex systemctl is-system-running 2>/dev/null || true)
  [[ "$st" == running || "$st" == degraded ]] && break
  sleep 1
done
echo "== system: $st"
ex systemctl --no-pager --failed --plain | sed -n '1,12p'

echo "== units"
ex systemctl is-active wadd.socket wadd.service || true
ex stat -c '%n %a %U:%G' /run/wadd/wadd.sock
echo "== wadd migrate"
ex journalctl -b -u wadd --no-pager -o cat | grep -E 'wadd migrate' || true
echo "== /etc/containers/systemd now"
ex ls /etc/containers/systemd
echo "== workspaces.json"
ex python3 -c '
import json
for w in json.load(open("/var/lib/wadspaces/workspaces.json")):
    print(w["id"], w["display"], w.get("hotkey"))'
echo "== /run/containers/systemd"
ex ls /run/containers/systemd || true

api() { # user path
  ex runuser -u "$1" -- curl -s -o /dev/null -w '%{http_code}' --unix-socket /run/wadd/wadd.sock "http://wadd$2" || true
}
echo "== the socket: wad $(api wad /v1/health), admin $(api admin /v1/health), stranger $(api stranger /v1/health)"
echo "== wadd's warnings"
ex journalctl -b -u wadd --no-pager -o cat | grep -iE 'warn|error' | tail -10 || true
