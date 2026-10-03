#!/usr/bin/env bash
# Renders every HUD surface, dark and light, to PNGs: on a virtual KWin
# screen (nothing opens on your desktop), with real layer-shell.
#
#   apps/hud/snapshot.sh [OUT_DIR] [ICON]
#
# ICON: an image to show as the switcher's Writing icon (default: the
# Writing workspace's icon).
# Build first: cargo build -p wadspaces-hud. Needs kwin_wayland.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${HERE}/../.." && pwd)"
OUT="${1:-${XDG_RUNTIME_DIR}/hud-snapshot}"
ICON="${2:-${ROOT}/host/usr/share/wadspaces/icons/writing.png}"
mkdir -p "${OUT}"
for theme in dark light; do
    mkdir -p "${OUT}/${theme}"
    timeout 60 dbus-run-session -- bash -c '
        ulimit -c 0
        kwin_wayland --virtual --socket wad-hud-$2 --width 1280 --height 800 > /dev/null 2>&1 &
        K=$!
        for _ in $(seq 50); do [[ -S "$XDG_RUNTIME_DIR/wad-hud-$2" ]] && break; sleep 0.2; done
        WAYLAND_DISPLAY=wad-hud-$2 GDK_BACKEND=wayland GTK_A11Y=none \
            WADSPACES_HUD_SNAPSHOT="$0" WADSPACES_HUD_SNAPSHOT_ICON="$1" WADSPACES_HUD_THEME="$2" \
            WADD_URL=http://127.0.0.1:9 timeout 20 "$3/target/debug/wadspaces-hud" > "$0/log" 2>&1 || true
        kill $K
    ' "${OUT}/${theme}" "${ICON}" "${theme}" "${ROOT}" > /dev/null 2>&1 < /dev/null
    grep -h "Gtk-WARNING\|Gtk-CRITICAL\|wrote" "${OUT}/${theme}/log" | sed "s/^/${theme}: /" || true
done
