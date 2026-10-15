#!/usr/bin/env bash
# Renders every HUD surface, dark and light, to PNGs: on a virtual KWin
# screen (nothing opens on your desktop), with real layer-shell.
#
#   apps/hud/snapshot.sh [OUT_DIR] [ICON]
#
# ICON: an image to show as the switcher's Writing icon (default: the
# terminal's icon).
# Build first: cargo build -p wadspaces-hud. Needs kwin_wayland.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${HERE}/../.." && pwd)"
OUT="${1:-${XDG_RUNTIME_DIR}/hud-snapshot}"
ICON="${2:-${ROOT}/host/usr/share/wadspaces/icons/terminal.png}"
mkdir -p "${OUT}"
for theme in dark light; do
    mkdir -p "${OUT}/${theme}"
    # Without your desktop's display: what the private bus starts (GTK asks
    # for the settings portal) would attach to it and outlive the run.
    timeout 60 env -u WAYLAND_DISPLAY -u DISPLAY dbus-run-session -- bash -c '
        ulimit -c 0
        kwin_wayland --virtual --socket wad-hud-$2 --width 1280 --height 800 > /dev/null 2>&1 &
        K=$!
        for _ in $(seq 50); do [[ -S "$XDG_RUNTIME_DIR/wad-hud-$2" ]] && break; sleep 0.2; done
        WAYLAND_DISPLAY=wad-hud-$2 GDK_BACKEND=wayland GTK_A11Y=none \
            WADSPACES_HUD_SNAPSHOT="$0" WADSPACES_HUD_SNAPSHOT_ICON="$1" WADSPACES_HUD_THEME="$2" \
            WADSPACES_HUD_SNAPSHOT_WALLPAPER="$3/assets/public/wallpapers/cosmic-bodybuilding.png" \
            WADD_URL=http://127.0.0.1:9 timeout 20 "$3/target/debug/wadspaces-hud" > "$0/log" 2>&1 || true
        kill $K
        # Whatever the bus started (portals) goes with it.
        sleep 1
        for p in $(pgrep -u "$(id -u)" -f "^/usr/libexec/xdg-"); do
            tr "\0" "\n" < /proc/$p/environ 2>/dev/null | grep -qxF "DBUS_SESSION_BUS_ADDRESS=$DBUS_SESSION_BUS_ADDRESS" && kill $p
        done
        true
    ' "${OUT}/${theme}" "${ICON}" "${theme}" "${ROOT}" > /dev/null 2>&1 < /dev/null
    grep -h "Gtk-WARNING\|Gtk-CRITICAL\|wrote" "${OUT}/${theme}/log" | sed "s/^/${theme}: /" || true
done
