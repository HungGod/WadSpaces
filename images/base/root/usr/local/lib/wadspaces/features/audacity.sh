# Audacity from its AppImage, extracted to /opt/audacity (as linuxserver's
# docker-audacity does: a container has no FUSE to mount it). Sound goes to
# the machine's PipeWire through the base's PulseAudio client.
# AUDACITY_URL pins a release's AppImage; default is the latest.
apt_install libatk1.0-0t64 libatk-bridge2.0-0t64 libnss3 libportaudio2 libgl1 libegl1 \
    libfontconfig1 libxkbcommon-x11-0 libxcb-cursor0 libxcb-icccm4 libxcb-keysyms1 \
    libxcb-shape0 libxcb-xinerama0 libxcb-randr0 libxcb-render-util0 libxcb-image0 \
    libwayland-cursor0 libwayland-egl1 libdbus-1-3 libgtk-3-0t64
AUDACITY_URL="${AUDACITY_URL:-$(github_latest_asset audacity/audacity 'audacity-linux-[0-9.]+-x86_64\.AppImage$')}"
[[ -n "${AUDACITY_URL}" ]] || { echo "could not find an Audacity AppImage" >&2; exit 1; }
echo "audacity: ${AUDACITY_URL}"
cd /tmp
curl -fsSL -o /tmp/audacity.app "${AUDACITY_URL}"
chmod +x /tmp/audacity.app
./audacity.app --appimage-extract > /dev/null
rm -rf /opt/audacity && mv squashfs-root /opt/audacity
rm -f /tmp/audacity.app
cd /
chmod -R a+rX /opt/audacity
# The AppImage loads PortAudio by its unversioned name.
ln -sf /usr/lib/x86_64-linux-gnu/libportaudio.so.2 /usr/lib/x86_64-linux-gnu/libportaudio.so
ICON="$(find /opt/audacity -maxdepth 1 \( -name '*.svg' -o -name '*.png' \) | sort | head -n1)"
[[ -n "${ICON}" ]] || ICON=/opt/audacity/.DirIcon
EXT="${ICON##*.}"; [[ "${EXT}" == svg ]] || EXT=png
if [[ "${EXT}" == svg ]]; then
    install -D -m 0644 "${ICON}" /usr/share/icons/hicolor/scalable/apps/wadspaces-audacity.svg
else
    install -D -m 0644 "${ICON}" /usr/share/icons/hicolor/256x256/apps/wadspaces-audacity.png
fi
cat > /usr/local/bin/audacity <<'WRAP'
#!/bin/bash
exec /opt/audacity/AppRun "$@"
WRAP
chmod 755 /usr/local/bin/audacity
cat > /usr/share/applications/wadspaces-audacity.desktop <<'DESK'
[Desktop Entry]
Type=Application
Name=Audacity
Comment=Record and edit audio
Exec=/usr/local/bin/audacity %F
Icon=wadspaces-audacity
Terminal=false
Categories=AudioVideo;Audio;AudioVideoEditing;
DESK
add_desktop_entry audacity wadspaces-audacity.desktop
