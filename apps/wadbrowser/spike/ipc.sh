#!/usr/bin/env bash
# One browser per user: a running WadBrowser takes later launches' requests.
# On a headless sway, this starts the browser, then hands it a web app and a
# link (as a desktop launcher and xdg-open would), timing each hand-off, and
# prints the windows sway has: their app_ids and titles.
#
#   spike/ipc.sh [OUT_DIR]        (cargo build -p wadbrowser first)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${HERE}/../../.." && pwd)"
OUT="${1:-${XDG_RUNTIME_DIR}/wadbrowser-ipc}"
RT_NAME=wadbrowser-ipc-sway
RT="${XDG_RUNTIME_DIR}/${RT_NAME}"
APP="${ROOT}/target/debug/wadbrowser"
# The socket's path must stay under 108 bytes: a short runtime dir of its own.
RUN_DIR="${XDG_RUNTIME_DIR}/wbipc-run"
rm -rf "${OUT}" "${RT}" "${RUN_DIR}"
mkdir -p "${OUT}"/{data,cache,config,state} "${RUN_DIR}"
mkdir -m 700 "${RT}"
if command -v sway > /dev/null; then BIN=""; LIBS=""
else BIN="${ROOT}/.build/sway/usr/bin/"; LIBS="${ROOT}/.build/sway/usr/lib64"; fi
printf 'output HEADLESS-1 resolution 1280x800\ndefault_border none\n' > "${OUT}/sway.conf"
env -u WAYLAND_DISPLAY -u DISPLAY XDG_RUNTIME_DIR="${RT}" WLR_BACKENDS=headless WLR_RENDERER=pixman \
    WLR_LIBINPUT_NO_DEVICES=1 ${LIBS:+LD_LIBRARY_PATH=${LIBS}} "${BIN}sway" -c "${OUT}/sway.conf" > "${OUT}/sway.log" 2>&1 &
SWAY=$!
trap 'kill ${SWAY} 2>/dev/null; wait ${SWAY} 2>/dev/null; rm -rf "${RT}" "${RUN_DIR}"' EXIT
for _ in $(seq 50); do [[ -S "${RT}/wayland-1" ]] && break; sleep 0.1; done
sm() { env XDG_RUNTIME_DIR="${RT}" ${LIBS:+LD_LIBRARY_PATH=${LIBS}} "${BIN}swaymsg" -s "$(ls "${RT}"/sway-ipc.*.sock)" "$@"; }

# Its own runtime dir (the socket lives there) and profile, on a private bus.
env WAYLAND_DISPLAY="${RT_NAME}/wayland-1" GDK_BACKEND=wayland dbus-run-session -- env \
    XDG_DATA_HOME="${OUT}/data" XDG_CACHE_HOME="${OUT}/cache" XDG_CONFIG_HOME="${OUT}/config" \
    XDG_STATE_HOME="${OUT}/state" WADBROWSER_RUN="${RUN_DIR}" OUT="${OUT}" APP="${APP}" \
    bash -c '
        ulimit -c 0
        export XDG_RUNTIME_DIR_REAL="$XDG_RUNTIME_DIR"
        # The socket goes in RUN_DIR: wadbrowser reads XDG_RUNTIME_DIR for it,
        # and WAYLAND_DISPLAY is relative to the real one, so make it absolute.
        export WAYLAND_DISPLAY="$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" XDG_RUNTIME_DIR="$WADBROWSER_RUN"
        "$APP" "data:text/html,<title>First</title>first" > "$OUT/browser.log" 2>&1 &
        B=$!
        for _ in $(seq 100); do [[ -S "$WADBROWSER_RUN/wadbrowser/ctl.sock" ]] && break; sleep 0.1; done
        sleep 2
        t0=$(date +%s%N); "$APP" --app spike --name "Spike App" --url "data:text/html,<title>App</title>app"; t1=$(date +%s%N)
        echo "IPC app hand-off $(( (t1 - t0) / 1000000 )) ms"
        t0=$(date +%s%N); "$APP" --default "data:text/html,<title>Link</title>link"; t1=$(date +%s%N)
        echo "IPC link hand-off $(( (t1 - t0) / 1000000 )) ms"
        t0=$(date +%s%N); "$APP" --app spike --url "data:text/html,<title>App</title>app"; t1=$(date +%s%N)
        echo "IPC app again $(( (t1 - t0) / 1000000 )) ms"
        sleep 2
        echo "WINDOWS"; sleep 3
        kill $B 2>/dev/null; wait $B 2>/dev/null
        for p in /proc/[0-9]*; do
            [[ ${p#/proc/} == "$$" ]] && continue
            tr "\0" "\n" 2>/dev/null < "$p/environ" | grep -qxF "DBUS_SESSION_BUS_ADDRESS=${DBUS_SESSION_BUS_ADDRESS}" && kill "${p#/proc/}" 2>/dev/null
        done
        true' > "${OUT}/ipc.log" 2>&1 < /dev/null &
RUN=$!
for _ in $(seq 150); do grep -q WINDOWS "${OUT}/ipc.log" 2>/dev/null && break; sleep 0.1; done
echo "--- windows:"
sm -t get_tree | python3 -c '
import json, sys
def walk(n):
    if n.get("pid"): print("  ", n.get("app_id"), "|", n.get("name"))
    for c in n.get("nodes", []) + n.get("floating_nodes", []): walk(c)
walk(json.load(sys.stdin))'
wait ${RUN} || true
grep "^IPC" "${OUT}/ipc.log"
grep -iE "warn|error|panic" "${OUT}/browser.log" | grep -v portal | head -5 || true
