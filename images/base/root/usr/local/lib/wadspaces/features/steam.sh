# Steam from Valve's .deb with the 32-bit graphics stack, as linuxserver's
# docker-steam. Games need the machine's GPU (/dev/dri, which wadspaces get).
# Its login is a saved sign-in (.steam/ and Steam's config/ and userdata/).
dpkg --add-architecture i386
apt_repo_added
apt_install bubblewrap zenity libc6:i386 libegl1:i386 libgbm1:i386 libgl1:i386 \
    libgl1-mesa-dri:i386 mesa-va-drivers:i386 mesa-vulkan-drivers:i386 \
    steam-libs steam-libs-i386 xdg-desktop-portal
STEAM_DEB_URL="${STEAM_DEB_URL:-https://cdn.fastly.steamstatic.com/client/installer/steam.deb}"
curl -fsSL -o /tmp/steam.deb "${STEAM_DEB_URL}"
apt_install /tmp/steam.deb
rm -f /tmp/steam.deb /etc/apt/sources.list.d/steam*.list /etc/apt/sources.list.d/steam*.sources
# Steam asks apt for what it thinks is missing; everything is here already.
cat > /usr/local/bin/steamdeps <<'NOOP'
#!/bin/sh
exit 0
NOOP
chmod 755 /usr/local/bin/steamdeps
# Without user namespaces (bubblewrap can't run) Steam still starts, without
# its web views' sandbox; games then need them, so it says so in its log.
cat > /usr/local/bin/wadspaces-steam <<'WRAP'
#!/bin/bash
args=()
if ! bwrap --ro-bind / / --dev /dev --proc /proc --unshare-pid /bin/true > /dev/null 2>&1; then
    echo "wadspaces-steam: no user namespaces here: Steam starts, but games may not" >&2
    args+=(-no-cef-sandbox)
fi
exec /usr/bin/steam "${args[@]}" "$@"
WRAP
chmod 755 /usr/local/bin/wadspaces-steam
sed -i 's|^Exec=/usr/bin/steam|Exec=/usr/local/bin/wadspaces-steam|; s|^Exec=steam|Exec=/usr/local/bin/wadspaces-steam|' \
    /usr/share/applications/steam.desktop
add_desktop_entry steam steam.desktop
