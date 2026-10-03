# Obsidian from its AppImage, extracted to /opt/obsidian.
# OBSIDIAN_VERSION (e.g. v1.8.10) pins a release; default is the latest.
need electron-deps
if [[ -n "${OBSIDIAN_VERSION:-}" ]]; then
    OBSIDIAN_URL="https://github.com/obsidianmd/obsidian-releases/releases/download/${OBSIDIAN_VERSION}/Obsidian-${OBSIDIAN_VERSION#v}.AppImage"
else
    OBSIDIAN_URL="$(github_latest_asset obsidianmd/obsidian-releases '/Obsidian-[0-9]+\.[0-9]+\.[0-9]+\.AppImage$')"
fi
[[ -n "${OBSIDIAN_URL}" ]] || { echo "could not find an Obsidian x86_64 AppImage" >&2; exit 1; }
echo "obsidian: ${OBSIDIAN_URL}"
cd /tmp
curl -fsSL -o /tmp/obsidian.app "${OBSIDIAN_URL}"
chmod +x /tmp/obsidian.app
./obsidian.app --appimage-extract > /dev/null
rm -rf /opt/obsidian && mv squashfs-root /opt/obsidian
install -D -m 0644 /opt/obsidian/usr/share/icons/hicolor/512x512/apps/obsidian.png \
    /usr/share/icons/hicolor/512x512/apps/obsidian.png
rm -f /tmp/obsidian.app
cd /
wadspaces-wrap-electron /opt/obsidian/obsidian /usr/bin/obsidian
cat > /usr/share/applications/md.obsidian.Obsidian.desktop <<'DESK'
[Desktop Entry]
Type=Application
Name=Obsidian
Comment=Markdown notes
Exec=/usr/bin/obsidian %u
Icon=obsidian
Terminal=false
Categories=Office;TextEditor;
MimeType=x-scheme-handler/obsidian;
StartupWMClass=obsidian
DESK
add_desktop_entry obsidian md.obsidian.Obsidian.desktop
add_chown obsidian /opt/obsidian
cat > /etc/wadspaces/autostart.d/obsidian.sh <<'HOOK'
case "${AUTOSTART_OBSIDIAN}" in
  [Tt][Rr][Uu][Ee]) obsidian & ;;
esac
HOOK
