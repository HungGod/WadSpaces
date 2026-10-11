# Dolphin (GameCube and Wii emulator): linuxserver's build, which
# images/build.sh staged in the base at /usr/local/lib/wadspaces/dolphin
# (built from source in docker-dolphin; too long to build in a template).
# Here: its runtime libraries, the files in place, and a launcher.
STAGED=/usr/local/lib/wadspaces/dolphin
[[ -x "${STAGED}/usr/local/bin/dolphin-emu" ]] || { echo "no staged Dolphin in ${STAGED} (images/build.sh stages it)" >&2; exit 1; }
# The libraries it links (dpkg -S over its ldd, in linuxserver's trixie
# image); apt brings what they need. The ldd check below catches any missed.
apt_install libavcodec61 libavformat61 libavutil59 libswresample5 libswscale8 libqt6core6t64 libqt6gui6 \
    libqt6widgets6 libqt6dbus6 qt6-svg-plugins qt6-wayland libevdev2 libmbedcrypto16 libcurl4t64 libpulse0 \
    libudev1 libopengl0 libegl1 libglx0 libx11-6 libxi6 libxrandr2 libxkbcommon0 libmd4c0 libsystemd0
cp -a "${STAGED}/usr/local/." /usr/local/
# The desktop looks for icons in /usr/share/icons.
cp -a /usr/local/share/icons/hicolor/. /usr/share/icons/hicolor/
mkdir -p /usr/games && ln -sf /usr/local/bin/dolphin-emu /usr/games/dolphin-emu
# wadspaces-layout looks for launchers in /usr/share/applications.
sed 's|^Exec=.*|Exec=/usr/local/bin/dolphin-emu %f|' /usr/local/share/applications/dolphin-emu.desktop \
    > /usr/share/applications/dolphin-emu.desktop
if ldd /usr/local/bin/dolphin-emu | grep 'not found'; then
    echo "dolphin-emu is missing the libraries above" >&2
    exit 1
fi
add_desktop_entry dolphin dolphin-emu.desktop
