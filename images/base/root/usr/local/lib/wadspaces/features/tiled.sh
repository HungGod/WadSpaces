# Tiled map editor from its AppImage, extracted to /opt/tiled.
apt_install libegl1 libgl1 libfontconfig1 libdbus-1-3 libxkbcommon-x11-0 libxcb-cursor0 \
    libxcb-icccm4 libxcb-keysyms1 libxcb-shape0 libwayland-cursor0 libwayland-egl1
TILED_URL="${TILED_URL:-$(github_latest_asset mapeditor/tiled 'Linux.*x86_64\.AppImage$')}"
[[ -n "${TILED_URL}" ]] || { echo "could not find a Tiled AppImage" >&2; exit 1; }
echo "tiled: ${TILED_URL}"
cd /tmp
curl -fsSL -o /tmp/tiled.app "${TILED_URL}"
chmod +x /tmp/tiled.app
./tiled.app --appimage-extract > /dev/null
rm -rf /opt/tiled && mv squashfs-root /opt/tiled
rm -f /tmp/tiled.app
cd /
ICON="$(find /opt/tiled -path '*hicolor*' -name 'org.mapeditor.Tiled.png' | sort -V | tail -n1)"
[[ -n "${ICON}" ]] && install -D -m 0644 "${ICON}" /usr/share/icons/hicolor/256x256/apps/org.mapeditor.Tiled.png
cat > /usr/local/bin/tiled <<'WRAP'
#!/bin/bash
exec /opt/tiled/AppRun "$@"
WRAP
chmod 755 /usr/local/bin/tiled
cat > /usr/share/applications/wadspaces-tiled.desktop <<'DESK'
[Desktop Entry]
Type=Application
Name=Tiled
Comment=Tile map editor
Exec=/usr/local/bin/tiled %F
Icon=org.mapeditor.Tiled
Terminal=false
Categories=Graphics;Development;
DESK
add_desktop_entry tiled wadspaces-tiled.desktop
