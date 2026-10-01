#!/usr/bin/env bash
# Run wadd + a kiosk-like Chromium window on a normal desktop (no OS image).
#
#   dev/run-dev.sh            window
#   dev/run-dev.sh --kiosk    fullscreen, like the real thing (Alt+F4 to quit)
#
# Workspaces must exist as containers first, e.g.
#   cd ../containers/kale-b && podman-compose up --no-start
# Hotkeys need read access to /dev/input (sudo usermod -aG input $USER, re-login);
# otherwise use the launcher tiles or number keys.
set -euo pipefail
cd "$(dirname "$0")/.."

systemctl --user start podman.socket
PY="${PYTHON:-python3}"
"${PY}" -c 'import fastapi, uvicorn, websockets, httpx, yaml' 2>/dev/null || {
    echo "missing deps: sudo dnf install python3-fastapi python3-uvicorn python3-websockets python3-evdev" >&2
    exit 1
}

PYTHONPATH=. "${PY}" -m wadd --config dev/workspaces.dev.yaml serve --dev &
WADD=$!
trap 'kill ${WADD} 2>/dev/null' EXIT
until curl -fs -o /dev/null http://127.0.0.1:8080/api/health; do sleep 0.5; done

MODE=(--app=http://127.0.0.1:8080/)
[[ "${1:-}" == "--kiosk" ]] && MODE=(--kiosk http://127.0.0.1:8080/)
chromium-browser --ozone-platform-hint=auto --remote-debugging-port=9222 \
    --user-data-dir="${XDG_RUNTIME_DIR:-/tmp}/wadspaces-dev-kiosk" --no-first-run "${MODE[@]}"
