#!/usr/bin/env bash
# Two WadBrowsers set up differently, side by side (--instance, --setup), on
# a headless sway against a local server that sets a cookie and notes the
# cookies each request came with (requests.log):
#
#   - instance "spike-a": two web apps, "saved" on a saved sign-in (a folder
#     listed in WADBROWSER_SIGNINS) and "loose" with none ("Don't save")
#   - instance "spike-b": a Focus window, nothing else
#
# Checks there are two browser processes with a socket each, that launching
# spike-a again hands over to it, that "loose" keeps nothing once its window
# closes (and leaves nothing on disk), and that "saved" keeps its cookie in
# the sign-in's folder.
#
#   spike/instances.sh [OUT_DIR]        (cargo build -p wadbrowser first)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${HERE}/../../.." && pwd)"
OUT="${1:-${XDG_RUNTIME_DIR}/wadbrowser-instances}"
RT_NAME=wbinst-sway
RT="${XDG_RUNTIME_DIR}/${RT_NAME}"
APP="${ROOT}/target/debug/wadbrowser"
RUN_DIR="${XDG_RUNTIME_DIR}/wbinst-run"
rm -rf "${OUT}" "${RT}" "${RUN_DIR}"
mkdir -p "${OUT}"/{data,cache,config,state,signin-s1} "${RUN_DIR}"
mkdir -m 700 "${RT}"
if command -v sway > /dev/null; then BIN=""; LIBS=""
else BIN="${ROOT}/.build/sway/usr/bin/"; LIBS="${ROOT}/.build/sway/usr/lib64"; fi
printf 'output HEADLESS-1 resolution 1280x800\ndefault_border none\n' > "${OUT}/sway.conf"
env -u WAYLAND_DISPLAY -u DISPLAY XDG_RUNTIME_DIR="${RT}" WLR_BACKENDS=headless WLR_RENDERER=pixman \
    WLR_LIBINPUT_NO_DEVICES=1 ${LIBS:+LD_LIBRARY_PATH=${LIBS}} "${BIN}sway" -c "${OUT}/sway.conf" > "${OUT}/sway.log" 2>&1 &
SWAY=$!
PORT=$((20000 + RANDOM % 10000))
python3 -I -c '
import http.server, sys
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        sent = self.headers.get("Cookie") or "none"
        with open(sys.argv[2], "a") as f: f.write(f"{self.path[1:]} cookies: {sent}\n")
        body = f"<title>{self.path[1:]}</title>{sent}".encode()
        self.send_response(200)
        self.send_header("Set-Cookie", f"seen-{self.path[1:]}=yes; Max-Age=86400; Path=/")
        self.send_header("Content-Type", "text/html")
        self.end_headers(); self.wfile.write(body)
    def log_message(self, *a): pass
http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()' "${PORT}" "${OUT}/requests.log" &
SERVER=$!
cleanup() {
    kill ${SWAY} ${SERVER} 2>/dev/null || true
    wait ${SWAY} 2>/dev/null || true
    # The private buses' document portal mounts itself in the runtime dir.
    fusermount3 -u "${RUN_DIR}/doc" 2>/dev/null || fusermount -u "${RUN_DIR}/doc" 2>/dev/null || true
    rm -rf "${RT}" "${RUN_DIR}"
}
trap cleanup EXIT
for _ in $(seq 50); do [[ -S "${RT}/wayland-1" ]] && break; sleep 0.1; done
sm() { env XDG_RUNTIME_DIR="${RT}" ${LIBS:+LD_LIBRARY_PATH=${LIBS}} "${BIN}swaymsg" -s "$(ls "${RT}"/sway-ipc.*.sock)" "$@"; }
windows() {
    sm -t get_tree | python3 -I -c '
import json, sys
def walk(n):
    if n.get("pid"): print(n.get("app_id"), "|", n.get("name"))
    for c in n.get("nodes", []) + n.get("floating_nodes", []): walk(c)
walk(json.load(sys.stdin))'
}
fail() { echo "FAILED: $*"; windows; exit 1; }

U="http://127.0.0.1:${PORT}"
cat > "${OUT}/a.json" <<JSON
{"mode":"browser","webapps":[{"id":"saved","name":"Saved","url":"${U}/saved"},{"id":"loose","name":"Loose","url":"${U}/loose"}],"signins":{"saved":"s1"}}
JSON
echo '{"mode":"focus","webapps":[],"signins":{}}' > "${OUT}/b.json"
printf '{"version":1,"signins":[{"id":"s1","name":"Saved","web":true,"apps":["saved"],"dir":"%s"}]}' "${OUT}/signin-s1" > "${OUT}/signins.json"

# Each launch as wadd starts one: its own runtime dir (sockets), profile
# folders and a private bus, all under OUT.
launch() { # log, args...
    local log=$1; shift
    env WAYLAND_DISPLAY="${RT}/wayland-1" GDK_BACKEND=wayland XDG_RUNTIME_DIR="${RUN_DIR}" \
        XDG_DATA_HOME="${OUT}/data" XDG_CACHE_HOME="${OUT}/cache" XDG_CONFIG_HOME="${OUT}/config" \
        XDG_STATE_HOME="${OUT}/state" WADBROWSER_SIGNINS="${OUT}/signins.json" \
        dbus-run-session -- "${APP}" "$@" > "${OUT}/${log}.log" 2>&1
}
wait_for() { # window pattern
    for _ in $(seq 150); do windows | grep -q "$1" && return 0; sleep 0.1; done
    return 1
}
requested() { # n-th request for a path, its cookies: "<path> cookies: ..."
    for _ in $(seq 150); do
        line=$(grep "^$1 " "${OUT}/requests.log" 2>/dev/null | sed -n "$2p")
        [[ -n "${line}" ]] && { echo "${line}"; return 0; }
        sleep 0.1
    done
    return 1
}
browsers() { pgrep -f "^${APP} --instance" | while read -r p; do tr '\0' ' ' < "/proc/$p/cmdline"; echo; done | grep -c . || true; }

launch a --instance spike-a --setup "${OUT}/a.json" &
A=$!
launch b --instance spike-b --setup "${OUT}/b.json" &
B=$!
wait_for "wadspaces-webapp-loose" || fail "spike-a's web apps didn't open"
wait_for "wadspaces-webapp-saved" || fail "spike-a's saved web app didn't open"
wait_for "^wadbrowser " || fail "spike-b's Focus window didn't open"
requested loose 1 > /dev/null && requested saved 1 > /dev/null || fail "the web apps didn't load"
[[ -S "${RUN_DIR}/wadbrowser/spike-a/ctl.sock" && -S "${RUN_DIR}/wadbrowser/spike-b/ctl.sock" ]] || fail "a socket per instance"
n=$(browsers)
[[ "${n}" == 2 ]] || fail "${n} browser processes, not 2"
echo "two instances: ok (a socket each, two processes)"

# Again: handed to the running spike-a, which only brings its windows up.
t0=$(date +%s%N)
launch a2 --instance spike-a --setup "${OUT}/a.json"
echo "spike-a again: handed over in $(( ($(date +%s%N) - t0) / 1000000 )) ms"
[[ "$(browsers)" == 2 ]] || fail "a third browser started"

# "Don't save": close loose's window, then open it again: no cookie, and
# nothing of it on disk.
sm "[app_id=wadspaces-webapp-loose] kill" > /dev/null
for _ in $(seq 50); do windows | grep -q wadspaces-webapp-loose || break; sleep 0.1; done
sleep 1
launch a3 --instance spike-a --setup "${OUT}/a.json"
wait_for "wadspaces-webapp-loose" || fail "loose didn't open again"
r=$(requested loose 2) || fail "loose didn't load again"
[[ "${r}" == "loose cookies: none" ]] || fail "loose kept its cookie after its window closed (${r})"
find "${OUT}" -path '*ephemeral*' | grep -q . && fail "an ephemeral profile left files: $(find "${OUT}" -path '*ephemeral*')"
echo "don't save: ok (no cookie after closing, nothing on disk)"

# "saved": its cookie is in the sign-in's folder; spike-a's own profiles
# are under instances/spike-a, apart from the user's WadBrowser.
sm "[app_id=wadspaces-webapp-saved] kill" > /dev/null
sleep 2
[[ -f "${OUT}/signin-s1/cookies.sqlite" ]] || fail "no cookies in the sign-in's folder"
grep -q "seen-saved" "${OUT}/signin-s1/cookies.sqlite" || fail "the saved cookie isn't in the sign-in's folder"
[[ ! -e "${OUT}/data/wadbrowser/profiles" ]] || fail "an instance wrote to the user's own profiles"
echo "saved sign-in: ok (${OUT}/signin-s1/cookies.sqlite)"
ls -d "${OUT}"/data/wadbrowser/instances/* "${OUT}"/state/wadbrowser/instances/* 2>/dev/null | sed "s|${OUT}/|  |"

sm "[app_id=.*] kill" > /dev/null || true
wait ${A} ${B} 2>/dev/null || true
grep -iE "panic|error" "${OUT}"/*.log | grep -v -iE "portal|dbus" | head -5 || true
echo ok
