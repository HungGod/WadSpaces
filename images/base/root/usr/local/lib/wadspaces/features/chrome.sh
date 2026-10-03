# Google Chrome, plus a wrapper that adds --no-sandbox / wayland detection.
# /usr/local/bin precedes /usr/bin on PATH, so `google-chrome` hits the wrapper.
need electron-deps
curl -fsSL -o /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
apt_install /tmp/chrome.deb
rm -f /tmp/chrome.deb /etc/apt/sources.list.d/google-chrome.list /etc/apt/sources.list.d/google-chrome.sources
wadspaces-wrap-electron /opt/google/chrome/google-chrome /usr/local/bin/google-chrome \
    --password-store=basic --no-first-run --no-default-browser-check
cat > /usr/share/applications/wadspaces-chrome.desktop <<'DESK'
[Desktop Entry]
Type=Application
Name=Chrome
Exec=/usr/local/bin/google-chrome %U
Icon=google-chrome
Terminal=false
Categories=Network;WebBrowser;
StartupWMClass=Google-chrome
DESK
add_desktop_entry chrome wadspaces-chrome.desktop
