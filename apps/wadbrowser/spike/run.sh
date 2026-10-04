#!/usr/bin/env bash
# WadBrowser's spike (src/spike.rs) on a headless sway, so nothing opens on
# your desktop: screenshots (grim) and each window's sway node, then the
# SPIKE lines the app printed.
#
#   spike/run.sh [OUT_DIR]
#   WADBROWSER_SPIKE_SITES="https://… …" spike/run.sh [OUT_DIR]   what WebKit
#       supports (WebRTC, DRM, codecs, GPU), then each site, screenshotted
#
# Build it first: cargo build -p wadbrowser --features spike. Uses sway, grim
# and swaymsg if installed, else the ones unpacked under .build/sway (see
# apps/wadd/dev/sway.sh; add grim the same way).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${HERE}/../../.." && pwd)"
OUT="${1:-${XDG_RUNTIME_DIR}/wadbrowser-spike}"
RT_NAME=wadbrowser-spike-sway
RT="${XDG_RUNTIME_DIR}/${RT_NAME}"
rm -rf "${OUT}" "${RT}"
mkdir -p "${OUT}"/{data,cache,config,downloads}
# Downloads land here, not in your own Downloads folder.
echo "XDG_DOWNLOAD_DIR=\"${OUT}/downloads\"" > "${OUT}/config/user-dirs.dirs"
mkdir -m 700 "${RT}"

if command -v sway > /dev/null && command -v grim > /dev/null; then BIN=""; LIBS=""
else BIN="${ROOT}/.build/sway/usr/bin/"; LIBS="${ROOT}/.build/sway/usr/lib64"; fi

cat > "${OUT}/sway.conf" <<CONF
output HEADLESS-1 resolution 1280x800
default_border none
CONF
# Windows float (centred, their own size) instead of tiling: a desktop with
# room around them, to drag tabs out onto.
[[ -n "${WADBROWSER_SPIKE_DRAG_OUT:-}${WADBROWSER_SPIKE_EDGES:-}" ]] && echo 'for_window [app_id=".*"] floating enable' >> "${OUT}/sway.conf"
cat > "${OUT}/shot.sh" <<SHOT
#!/usr/bin/env bash
export XDG_RUNTIME_DIR="${RT}" WAYLAND_DISPLAY=wayland-1 ${LIBS:+LD_LIBRARY_PATH=${LIBS}}
"${BIN}grim" "\$1.png"
"${BIN}swaymsg" -s "\$(ls ${RT}/sway-ipc.*.sock)" -t get_tree > "\$1.tree.json"
SHOT
chmod +x "${OUT}/shot.sh"

env -u WAYLAND_DISPLAY -u DISPLAY XDG_RUNTIME_DIR="${RT}" WLR_BACKENDS=headless WLR_RENDERER="${SWAY_RENDERER:-pixman}" \
    WLR_LIBINPUT_NO_DEVICES=1 ${LIBS:+LD_LIBRARY_PATH=${LIBS}} "${BIN}sway" -c "${OUT}/sway.conf" > "${OUT}/sway.log" 2>&1 &
SWAY=$!
trap 'kill ${SWAY} 2>/dev/null; wait ${SWAY} 2>/dev/null; rm -rf "${RT}"' EXIT
for _ in $(seq 50); do [[ -S "${RT}/wayland-1" ]] && break; sleep 0.1; done
# Each window as sway first maps it: its app_id then is what launchers and
# window rules see.
env XDG_RUNTIME_DIR="${RT}" ${LIBS:+LD_LIBRARY_PATH=${LIBS}} "${BIN}swaymsg" -s "$(ls "${RT}"/sway-ipc.*.sock)" \
    -t subscribe -m '["window"]' > "${OUT}/window-events.json" 2>/dev/null &

# A private session bus, and the headless display for anything it starts
# (portals): when the app is done, whatever is still on that bus goes too.
env WAYLAND_DISPLAY="${RT_NAME}/wayland-1" GDK_BACKEND=wayland dbus-run-session -- env \
    XDG_DATA_HOME="${OUT}/data" XDG_CACHE_HOME="${OUT}/cache" XDG_CONFIG_HOME="${OUT}/config" \
    WAYLAND_DEBUG=client \
    WADBROWSER_SPIKE_DIR="${OUT}" WADBROWSER_SPIKE_SHOT="${OUT}/shot.sh" \
    ${WADBROWSER_SPIKE_DRAG:+WADBROWSER_SPIKE_DRAG=1} ${WADBROWSER_SPIKE_DRAG_OUT:+WADBROWSER_SPIKE_DRAG_OUT=1} ${WADBROWSER_SPIKE_EDGES:+WADBROWSER_SPIKE_EDGES=1} \
    ${WADBROWSER_SPIKE_SITES:+WADBROWSER_SPIKE_SITES="${WADBROWSER_SPIKE_SITES}"} \
    ${WADBROWSER_SPIKE_CLOSE_SOURCE:+WADBROWSER_SPIKE_CLOSE_SOURCE=1} \
    HOME="${OUT}" bash -c '
        ulimit -c 0
        timeout 240 "$0"
        unset WAYLAND_DEBUG
        for p in /proc/[0-9]*; do
            [[ ${p#/proc/} == "$$" ]] && continue
            tr "\0" "\n" 2>/dev/null < "$p/environ" | grep -qxF "DBUS_SESSION_BUS_ADDRESS=${DBUS_SESSION_BUS_ADDRESS}" \
                && kill "${p#/proc/}" 2>/dev/null
        done
        true' "${ROOT}/target/debug/wadbrowser" \
    > "${OUT}/app.log" 2> >(grep --line-buffered -E 'set_app_id|WARN|ERROR|CRITICAL|panick' > "${OUT}/err.log") \
    < /dev/null || true
sleep 0.3
grep "^SPIKE" "${OUT}/app.log" | cut -c1-400
echo "--- windows as mapped (sway 'new' events):"
python3 - "${OUT}/window-events.json" <<'PY'
import json, sys
dec, text, i = json.JSONDecoder(), open(sys.argv[1]).read(), 0
while i < len(text):
    while i < len(text) and text[i].isspace(): i += 1
    if i >= len(text): break
    e, i = dec.raw_decode(text, i)
    if e.get("change") == "new": print("  new:", e["container"].get("app_id"))
PY
echo "--- app_ids set:"; grep -o 'set_app_id("[^"]*")' "${OUT}/err.log" | sort | uniq -c
echo "--- other warnings:"; grep -v set_app_id "${OUT}/err.log" | head -20
echo "screenshots in ${OUT}"
