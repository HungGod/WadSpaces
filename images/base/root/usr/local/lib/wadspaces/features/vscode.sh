# Visual Studio Code from Microsoft's .deb (same source as linuxserver/docker-vscode).
need electron-deps
CODE_URL="${CODE_URL:-https://update.code.visualstudio.com/latest/linux-deb-x64/stable}"
curl -fsSL -o /tmp/code.deb "${CODE_URL}"
apt_install /tmp/code.deb
rm -f /tmp/code.deb /etc/apt/sources.list.d/vscode.list /etc/apt/sources.list.d/vscode.sources
# Desktop launcher runs the Electron binary through the shared wrapper
# (--no-sandbox, native Wayland under labwc) like the other Electron apps.
# --password-store=basic: there is no keyring daemon in the session.
# `code` in a terminal is still Microsoft's CLI at /usr/bin/code.
wadspaces-wrap-electron /usr/share/code/code /usr/local/bin/code-desktop --password-store=basic
cat > /usr/share/applications/wadspaces-vscode.desktop <<'DESK'
[Desktop Entry]
Type=Application
Name=VS Code
Comment=Code editor
Exec=/usr/local/bin/code-desktop %F
Icon=vscode
Terminal=false
Categories=Development;IDE;
StartupWMClass=Code
DESK
add_desktop_entry vscode wadspaces-vscode.desktop
