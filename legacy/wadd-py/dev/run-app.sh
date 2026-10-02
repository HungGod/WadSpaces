#!/usr/bin/env bash
# The machine app (Tauri, the `machine` UI) on this laptop, in a window,
# against a dev wadd: no kiosk browser, no keyboard grab, state kept in
# ~/.local/state/wadspaces-dev, containers on the user podman socket.
#
#   legacy/wadd-py/dev/run-app.sh              wadd + the app (hot reload)
#   legacy/wadd-py/dev/run-app.sh --wadd-only  just wadd (e.g. for the browser)
#
# Careful: Wi-Fi and Power in the app act on this laptop for real (nmcli,
# systemctl), and GitHub sign-in sets the user podman secret github_token.
# There's no cloud section, so the laptop isn't linked to your account.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(cd ../.. && pwd)"
STATE="${XDG_STATE_HOME:-${HOME}/.local/state}/wadspaces-dev"
mkdir -p "${STATE}"/{state,projects,quadlets,secrets}
CONFIG="${STATE}/wadd.yaml"
cat > "${CONFIG}" <<YAML
version: 1
machine:
  name: $(hostname -s)
daemon:
  backend: podman
  port: 8080
  keys:
    enabled: false
  state_dir: ${STATE}/state
  projects_dir: ${STATE}/projects
  quadlet_dir: ${STATE}/quadlets
  secrets_dir: ${STATE}/secrets
wadcreator:
  enabled: false
workspaces:
  - id: writing
    name: Writing
    image: localhost/wadspaces-cosmic-bodybuilding:latest
    display: host
    hotkey: 1
YAML

systemctl --user start podman.socket
PY=.venv/bin/python
[[ -x "${PY}" ]] || PY=python3
PYTHONPATH=. "${PY}" -m wadd --config "${CONFIG}" serve --dev --no-cdp --no-hotkeys &
WADD=$!
trap 'kill ${WADD} 2>/dev/null' EXIT
until curl -fs -o /dev/null http://127.0.0.1:8080/api/health; do
    kill -0 "${WADD}" 2>/dev/null || { echo "wadd didn't start" >&2; exit 1; }
    sleep 0.5
done
echo ">> wadd on http://127.0.0.1:8080 (state in ${STATE})"

if [[ "${1:-}" == "--wadd-only" ]]; then
    wait "${WADD}"
else
    [[ -f "${HOME}/.cargo/env" ]] && source "${HOME}/.cargo/env"
    cd "${ROOT}/apps/wadcreator" && npm run app
fi
