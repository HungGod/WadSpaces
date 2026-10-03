# Android Studio, unpacked to /opt/android-studio. The SDK is downloaded by the
# first-run wizard into /config/Android, so persist /config. The emulator also
# needs /dev/kvm passed into the container.
# ANDROID_STUDIO_URL pins a specific linux tar.gz.
apt_install libxi6 libxrender1 libxtst6 libfreetype6 libfontconfig1 libc6 libncurses6 \
    libstdc++6 lib32z1 libbz2-1.0 libpulse0
if [[ -z "${ANDROID_STUDIO_URL:-}" ]]; then
    ANDROID_STUDIO_URL="$(curl -fsSL https://developer.android.com/studio \
        | grep -oE 'https://[^"]+/android-studio-[^"/]+-linux\.tar\.gz' | head -n1)"
fi
[[ -n "${ANDROID_STUDIO_URL}" ]] || { echo "could not find the Android Studio download; set ANDROID_STUDIO_URL" >&2; exit 1; }
# The page links edgedl.me.gvt1.com, which is IPv6-only; build containers
# usually have no IPv6. The redirector serves the same file over IPv4.
ANDROID_STUDIO_URL="${ANDROID_STUDIO_URL/#https:\/\/edgedl.me.gvt1.com\//https://redirector.gvt1.com/edgedl/}"
echo "android studio: ${ANDROID_STUDIO_URL}"
curl -fsSL -o /tmp/android-studio.tar.gz "${ANDROID_STUDIO_URL}"
tar -xzf /tmp/android-studio.tar.gz -C /opt
rm -f /tmp/android-studio.tar.gz
install -D -m 0644 /opt/android-studio/bin/studio.png /usr/share/icons/hicolor/128x128/apps/android-studio.png
if [[ -x /opt/android-studio/bin/studio ]]; then STUDIO=/opt/android-studio/bin/studio; else STUDIO=/opt/android-studio/bin/studio.sh; fi
cat > /usr/share/applications/wadspaces-android-studio.desktop <<DESK
[Desktop Entry]
Type=Application
Name=Android Studio
Exec=${STUDIO} %f
Icon=android-studio
Terminal=false
Categories=Development;IDE;
StartupWMClass=jetbrains-studio
DESK
add_desktop_entry android-studio wadspaces-android-studio.desktop
