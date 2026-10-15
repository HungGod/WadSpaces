#!/usr/bin/env bash
# The native client on a screen of its own: a headless kwin with its own
# socket and D-Bus session, so nothing opens on your desktop and nothing
# there is touched. wadd: WADD_SOCKET's, else none.
#
#   apps/desktop/dev/headless.sh snapshot [OUT_DIR]   every page, dark and light, to PNGs
#   apps/desktop/dev/headless.sh measure [--tauri]    its memory (PSS of all its
#                                                     processes) once it's settled;
#                                                     --tauri: the Tauri client's too
#
# Only what this script starts is stopped, by PID. GTK's portals are off
# (GDK_DEBUG=no-portals): no helpers are left behind.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
MODE="${1:-snapshot}"
OUT="${2:-${ROOT}/.build/desktop-shots}"
WORK="${ROOT}/.build/desktop-headless"
mkdir -p "${WORK}"
case "${MODE}" in
    snapshot) (cd "${ROOT}" && cargo build -q -p wadspaces-desktop); BIN="${ROOT}/target/debug/wadspaces-desktop" ;;
    measure) (cd "${ROOT}" && cargo build -q --release -p wadspaces-desktop); BIN="${ROOT}/target/release/wadspaces-desktop" ;;
    *) echo "usage: $0 snapshot [OUT_DIR] | measure [--tauri]" >&2; exit 2 ;;
esac
TAURI=""
[[ "${MODE}" == "measure" && "${2:-}" == "--tauri" ]] && TAURI="${ROOT}/target/release/client"

# Inside its own D-Bus session, with no display of yours.
env -u WAYLAND_DISPLAY -u DISPLAY WADD_SOCKET="${WADD_SOCKET:-/nonexistent/wadd.sock}" \
    MODE="${MODE}" OUT="${OUT}" WORK="${WORK}" BIN="${BIN}" TAURI="${TAURI}" \
    dbus-run-session -- bash -c '
set -u
SOCK="wad-desktop-$$"
kwin_wayland --virtual --socket "${SOCK}" --width 1280 --height 800 > "${WORK}/kwin.log" 2>&1 &
KWIN=$!
# On the way out: kwin, and whatever this session'"'"'s bus started (the
# virtual kwin'"'"'s keyboard asks for portals): only processes on this bus.
ours() {
    for p in $(pgrep -u "$(id -u)" || true); do
        [[ "$p" == "$$" ]] && continue
        tr "\0" "\n" 2>/dev/null < "/proc/$p/environ" | grep -qxF "DBUS_SESSION_BUS_ADDRESS=${DBUS_SESSION_BUS_ADDRESS}" && echo "$p"
    done
}
trap "kill ${KWIN} 2>/dev/null; wait ${KWIN} 2>/dev/null; for p in \$(ours); do kill \$p 2>/dev/null; done" EXIT
for _ in $(seq 50); do [[ -S "${XDG_RUNTIME_DIR}/${SOCK}" ]] && break; sleep 0.2; done
export WAYLAND_DISPLAY="${SOCK}" GDK_BACKEND=wayland GDK_DEBUG=no-portals GTK_A11Y=none

# The proportional memory of a process and everything it started, in MB.
pss() {
    local pids=("$1") i=0 total=0 kb
    while (( i < ${#pids[@]} )); do
        for c in $(pgrep -P "${pids[i]}" || true); do pids+=("$c"); done
        i=$((i + 1))
    done
    for p in "${pids[@]}"; do
        kb=$(awk "/^Pss:/{print \$2}" "/proc/${p}/smaps_rollup" 2>/dev/null || echo 0)
        printf "    %-20s %5d MB\n" "$(tr -d "\0" < "/proc/${p}/comm" 2>/dev/null)" $(( ${kb:-0} / 1024 ))
        total=$(( total + ${kb:-0} ))
    done
    printf "    total                %5d MB\n" $(( total / 1024 ))
}

case "${MODE}" in
    snapshot)
        mkdir -p "${OUT}"
        timeout 90 "${BIN}" --kiosk --snapshot "${OUT}" > "${WORK}/app.log" 2>&1 || true
        grep -h "wrote\|WARN\|Gtk-" "${WORK}/app.log" || true
        ;;
    measure)
        "${BIN}" --kiosk > "${WORK}/app.log" 2>&1 &
        APP=$!
        sleep 6
        echo "native:"; pss "${APP}"
        kill "${APP}"; wait "${APP}" 2>/dev/null || true
        if [[ -n "${TAURI}" ]]; then
            "${TAURI}" --kiosk > "${WORK}/tauri.log" 2>&1 &
            APP=$!
            sleep 12
            echo "tauri:"; pss "${APP}"
            kill "${APP}"; wait "${APP}" 2>/dev/null || true
        fi
        ;;
esac
'
