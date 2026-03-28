# WadBrowser

Chromium-based minimal browser (Electron) with no URL bar, WebRTC, drag-and-drop tabs, download manager, and packager integration for turning web addresses into desktop apps.

## Running the browser

**Prerequisites:** Node.js 18+ and npm.

```bash
# Install dependencies (once)
npm install

# Run the browser
npm run start

# Run and open a specific URL
npm run start -- --url "https://example.com"

# Run with a packager-generated config (app name, home URL, icon)
npm run start -- --config /path/to/config.json
```

**Build (Linux AppImage):**

```bash
npm run build
# Output: dist/WadBrowser.AppImage
```

Run the AppImage with an optional URL: `./dist/WadBrowser.AppImage "https://example.com"` or `./dist/WadBrowser.AppImage --url "https://example.com"`.

## Packager

The packager generates `config.json`, launcher scripts, and `.desktop` files so you can create desktop apps that open a specific site in WadBrowser.

**Prerequisites:** Python 3.9+ and the packager dependencies.

```bash
cd packager
python -m venv .venv
source .venv/bin/activate 
pip install -r requirements.txt
```

**Run the packager:**

```bash
# From project root (recommended)
python3 packager/packager.py

# Or from inside packager/
cd packager
python3 packager.py
```

Use `--project-dir` to point at the WadBrowser project root (so generated launchers run the Electron app). See `python3 packager/packager.py --help` for options. Input apps are listed in `packager/resources.json`.

## Features

- No search/URL bar (toolbar: back, forward, reload, home, downloads)
- Tabs: reorder by drag; drag to another window to dock or open in a new window; close last tab to close the window
- Download manager (list, progress, open folder, cancel)
- Context menu: Open link in new tab, Copy link, Copy
- Fullscreen (F11), minimize to tray when closing the last window
- Window: drag top bar to move; resize from bottom-right corner
- WebRTC supported
- Fedora KDE Plasma supported
