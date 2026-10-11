# LibreSprite (pixel art and sprite animation) from its AppImage, extracted to
# /opt/libresprite: a container has no FUSE to mount it.
# LIBRESPRITE_URL pins a release's AppImage; default is the latest.
apt_install libgl1 libegl1 libfontconfig1 libfreetype6 libxcursor1 libxi6 libxrandr2 \
    libxkbcommon0 libwayland-cursor0 libwayland-egl1
LIBRESPRITE_URL="${LIBRESPRITE_URL:-$(github_latest_asset LibreSprite/LibreSprite 'linux-x86_64\.AppImage$')}"
[[ -n "${LIBRESPRITE_URL}" ]] || { echo "could not find a LibreSprite AppImage" >&2; exit 1; }
echo "libresprite: ${LIBRESPRITE_URL}"
cd /tmp
curl -fsSL -o /tmp/libresprite.app "${LIBRESPRITE_URL}"
chmod +x /tmp/libresprite.app
./libresprite.app --appimage-extract > /dev/null
rm -rf /opt/libresprite && mv squashfs-root /opt/libresprite
rm -f /tmp/libresprite.app
cd /
# An AppImage's folders can come out readable by root alone.
chmod -R a+rX /opt/libresprite
# Its own libwayland is older than Debian's Mesa wants (libEGL_mesa needs
# wl_display_create_queue_with_name): use the system's.
find /opt/libresprite -name 'libwayland-*.so*' -delete
ICON="$(find /opt/libresprite -name '*.png' -path '*hicolor*' | sort -V | tail -n1)"
[[ -n "${ICON}" ]] || ICON=/opt/libresprite/.DirIcon
install -D -m 0644 "${ICON}" /usr/share/icons/hicolor/256x256/apps/wadspaces-libresprite.png
cat > /usr/local/bin/libresprite <<'WRAP'
#!/bin/bash
exec /opt/libresprite/AppRun "$@"
WRAP
chmod 755 /usr/local/bin/libresprite
cat > /usr/share/applications/wadspaces-libresprite.desktop <<'DESK'
[Desktop Entry]
Type=Application
Name=LibreSprite
Comment=Pixel art and sprite animation
Exec=/usr/local/bin/libresprite %F
Icon=wadspaces-libresprite
Terminal=false
Categories=Graphics;2DGraphics;RasterGraphics;
DESK
add_desktop_entry libresprite wadspaces-libresprite.desktop
