#!/usr/bin/env bash
# The app's spike (src/spike.rs) on a virtual screen: KWin with no window of
# its own, so nothing opens on your desktop. It saves screenshots and prints
# SPIKE lines (what the page reported), then exits.
#
#   spike/run.sh [OUT_DIR]            against WADD_SOCKET, else a throwaway
#                                     Rust wadd (wadd serve --user) started here
#   CLIENT_SPIKE_WIFI=1 spike/run.sh  also drive the Wi-Fi step (this machine's
#                                     own networks, from NetworkManager)
#
# Build it first: cargo build -p client --features spike,custom-protocol
# (with the UI built into ../dist-machine: npm run build:machine), and
# cargo build -p wadd. Needs kwin_wayland and dbus-run-session.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${HERE}/../../../.." && pwd)"
OUT="${1:-${XDG_RUNTIME_DIR}/client-spike}"
mkdir -p "${OUT}"/{data,cache,config}
WADD=""
if [[ -z "${WADD_SOCKET:-}" ]]; then
    W="${OUT}/wadd"
    rm -rf "${W}"
    mkdir -p "${W}/state" "${W}/projects"
    cat > "${W}/wadd.toml" <<TOML
[machine]
name = "spike"
[daemon]
socket = "${W}/wadd.sock"
state_dir = "${W}/state"
projects_dir = "${W}/projects"
[keys]
enabled = false
[display]
enabled = false
[cloud]
enabled = false
TOML
    "${ROOT}/target/debug/wadd" serve --user --config "${W}/wadd.toml" > "${W}/wadd.log" 2>&1 & WADD=$!
    for _ in $(seq 50); do [[ -S "${W}/wadd.sock" ]] && break; sleep 0.1; done
    export WADD_SOCKET="${W}/wadd.sock"
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
[[ -n "${WADD}" ]] && kill "${WADD}" 2>/dev/null
grep "^SPIKE" "${OUT}/app.log" | cut -c1-600
echo "screenshots in ${OUT}"
