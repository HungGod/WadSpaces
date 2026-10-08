#!/bin/bash
# The bridge as it runs on a machine: the workspace base image (labwc, its
# autostart starting wadspaces-clipboard) drawing on a headless sway that
# stands in for the machine's. A password manager inside the wadspace (the
# password-manager example, built for trixie) copies; the machine pastes it;
# it clears; the machine has nothing. Nothing shows on your desktop.
#
#   images/build.sh --only base     (first: the base with the bridge in it)
#   crates/wad-clip/dev/try-image.sh
set -euo pipefail
root=$(cd "$(dirname "$0")/../../.." && pwd)
cd "$root"
image=${IMAGE:-localhost/wadspaces-base:trixie}
work=$(mktemp -d "${TMPDIR:-/tmp}/wadclip-image.XXXXXX")
name=wadclip-try

echo ">> the password-manager example, for trixie (in the builder)"
podman run --rm --security-opt label=disable -v "$root":/src -w /src \
  -v wadspaces-cargo-registry:/usr/local/cargo/registry -v wadspaces-target-trixie:/target -e CARGO_TARGET_DIR=/target \
  localhost/wadspaces-builder:trixie \
  sh -c 'cargo build -q --locked --profile wadbrowser -p wad-clip --examples && cp /target/wadbrowser/examples/password-manager /src/.build/'

source apps/wadd/dev/sway.sh
cleanup() { podman rm -f -t 2 "$name" >/dev/null 2>&1 || true; stop_sway; rm -rf "$work"; }
trap cleanup EXIT
start_sway "$work"
machine=$rt/wayland-1

maps=()
for r in 0:1:1000 1000:0:1 1001:1001:64535; do maps+=(--uidmap "$r" --gidmap "$r"); done
podman run -d --name "$name" --security-opt label=disable "${maps[@]}" \
  -v "$rt":/run/wadspaces-display -e WADSPACES_WAYLAND=wayland-1 -e PUID=1000 -e PGID=1000 "$image" >/dev/null
for _ in $(seq 60); do podman logs "$name" 2>&1 | grep -q "clipboard is the machine's" && break; sleep 1; done
podman logs "$name" 2>&1 | grep -i "clipboard\|svc-de" | sed 's/^/     wadspace: /'

fail=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: wanted [$2], got [$3]"; fail=1; fi; }
paste() { WAYLAND_DISPLAY=$machine timeout 5 wl-paste -n 2>/dev/null || true; }

WAYLAND_DISPLAY=$machine wl-copy "from the machine"
sleep 1
podman cp .build/password-manager "$name":/usr/local/bin/password-manager
# Inside, as the desktop's user, on labwc's own display.
labwc_socket=$(podman exec "$name" sh -c 'ls /config/.XDG/wayland-[0-9] 2>/dev/null || ls ${XDG_RUNTIME_DIR:-/run/user/1000}/wayland-[0-9] 2>/dev/null' | head -1)
echo "     labwc's display: ${labwc_socket:-not found}"
podman exec -u abc "$name" password-manager "$labwc_socket" "hunter2 from labwc" 2 &
pm=$!
sleep 1
check "labwc -> the machine" "hunter2 from labwc" "$(paste)"
wait $pm || true
sleep 0.7
check "cleared on the machine too" "" "$(paste)"
exit $fail
