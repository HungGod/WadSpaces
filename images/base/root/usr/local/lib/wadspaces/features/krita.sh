# Krita from KDE's stable AppImage, extracted to /opt/krita (as linuxserver's
# docker-krita: the zsync file names the current one). Newer than Debian's.
# KRITA_URL pins an AppImage; default is the current stable.
apt_install libgl1 libegl1 libfontconfig1 libxkbcommon-x11-0 libxcb-cursor0 libxcb-icccm4 \
    libxcb-keysyms1 libxcb-shape0 libxcb-xinerama0 libxcb-randr0 libxcb-render-util0 \
    libxcb-image0 libwayland-cursor0 libwayland-egl1 libdbus-1-3 libxi6 libxrender1
ZSYNC=https://download.kde.org/stable/krita/updates/Krita-Stable-x86_64.appimage.zsync
# Into a file first: grep stopping at the match would cut curl off mid-download.
if [[ -z "${KRITA_URL:-}" ]]; then
    curl -fsSL -o /tmp/krita.zsync "${ZSYNC}"
    KRITA_URL="$(grep -a -m1 '^URL: https' /tmp/krita.zsync | awk '{print $2}' | tr -d '\r')"
    rm -f /tmp/krita.zsync
fi
[[ -n "${KRITA_URL}" ]] || { echo "could not find Krita's AppImage in ${ZSYNC}" >&2; exit 1; }
echo "krita: ${KRITA_URL}"
cd /tmp
curl -fsSL -o /tmp/krita.app "${KRITA_URL}"
chmod +x /tmp/krita.app
./krita.app --appimage-extract > /dev/null
rm -rf /opt/krita && mv squashfs-root /opt/krita
rm -f /tmp/krita.app
cd /
chmod -R a+rX /opt/krita
ICON="$(find /opt/krita/usr/share/icons/hicolor -name 'krita.png' 2>/dev/null | sort -V | tail -n1)"
[[ -n "${ICON}" ]] || ICON=/opt/krita/.DirIcon
install -D -m 0644 "${ICON}" /usr/share/icons/hicolor/256x256/apps/krita.png
cat > /usr/local/bin/krita <<'WRAP'
#!/bin/bash
exec /opt/krita/AppRun "$@"
WRAP
chmod 755 /usr/local/bin/krita
cat > /usr/share/applications/org.kde.krita.desktop <<'DESK'
[Desktop Entry]
Type=Application
Name=Krita
Comment=Digital painting
Exec=/usr/local/bin/krita %F
Icon=krita
Terminal=false
Categories=Qt;KDE;Graphics;2DGraphics;RasterGraphics;
StartupWMClass=krita
DESK
add_desktop_entry krita org.kde.krita.desktop
