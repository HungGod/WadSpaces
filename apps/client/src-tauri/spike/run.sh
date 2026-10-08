#!/usr/bin/env bash
# The app's spike (src/spike.rs) on a virtual screen: KWin with no window of
# its own, so nothing opens on your desktop. It saves screenshots and prints
# SPIKE lines (what the page reported), then exits.
#
#   spike/run.sh [OUT_DIR]               against WADD_URL (default: the fake wadd below)
#   CLIENT_SPIKE_WIFI=1 spike/run.sh  also drive the Wi-Fi step (the fake is offline)
#
# Build it first: cargo build -p client --features spike,custom-protocol
# (with the UI built into ../dist-machine: npm run build:machine). Needs
# kwin_wayland and dbus-run-session.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${HERE}/../../../.." && pwd)"
OUT="${1:-${XDG_RUNTIME_DIR}/client-spike}"
mkdir -p "${OUT}"/{data,cache,config}
FAKE=""
if [[ -z "${WADD_URL:-}" ]]; then
    python3 "${HERE}/fake-wadd.py" 18081 > /dev/null 2>&1 & FAKE=$!
    export WADD_URL=http://127.0.0.1:18081
fi
dbus-run-session -- bash -c '
    ulimit -c 0
    export XDG_DATA_HOME="$0/data" XDG_CACHE_HOME="$0/cache" XDG_CONFIG_HOME="$0/config"
    kwin_wayland --virtual --socket wad-spike --width 1280 --height 800 > "$0/kwin.log" 2>&1 &
    K=$!
    for _ in $(seq 50); do [[ -S "$XDG_RUNTIME_DIR/wad-spike" ]] && break; sleep 0.2; done
    WAYLAND_DISPLAY=wad-spike GDK_BACKEND=wayland CLIENT_SPIKE_DIR="$0" \
        timeout 60 "$1/target/debug/client" > "$0/app.log" 2>&1 || true
    kill $K
' "${OUT}" "${ROOT}" > /dev/null 2>&1 < /dev/null
[[ -n "${FAKE}" ]] && kill "${FAKE}" 2>/dev/null
grep "^SPIKE" "${OUT}/app.log" | cut -c1-600
echo "screenshots in ${OUT}"
