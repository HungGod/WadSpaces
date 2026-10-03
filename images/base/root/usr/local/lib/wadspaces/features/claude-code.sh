# Claude Code CLI (global npm install), opened in a terminal from the desktop.
# Login state lives in /config/.claude*, so persist /config to keep it.
need nodejs
npm install -g @anthropic-ai/claude-code
install -D -m 0644 /usr/share/wadspaces/claude-code.png /usr/share/icons/hicolor/256x256/apps/wadspaces-claude-code.png
cat > /usr/share/applications/wadspaces-claude-code.desktop <<'DESK'
[Desktop Entry]
Type=Application
Name=Claude Code
Comment=Claude Code in a terminal
Exec=foot --working-directory=/config/Desktop claude
Icon=wadspaces-claude-code
Terminal=false
Categories=Development;
DESK
add_desktop_entry claude-code wadspaces-claude-code.desktop
