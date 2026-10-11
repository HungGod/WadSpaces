#!/usr/bin/env bash
# The base's apps for real, as you, before wadd builds layers: a hand-written
# template image FROM localhost/wadspaces-base:trixie with the apps asked for
# (their features, or Debian packages as the catalog says), run in a headless
# sway the way a wadspace runs on a machine, each app's launcher opened as
# abc, and a screenshot of each window (.build/try-apps/<app>.png), the
# desktop's too (desktop.png: its icons, the Start button's logo and the one
# in the middle).
#
#   images/base/try-apps.sh                     every catalog app
#   images/base/try-apps.sh krita steam         just these
#   KEEP=1 images/base/try-apps.sh ...          leave the image and container
#
# Needs the base (images/build.sh) and sway (apps/wadd/dev/sway.sh says how).
set -euo pipefail
ulimit -c 0
root=$(cd "$(dirname "$0")/../.." && pwd)
dir=$root/.build/try-apps
img=localhost/wadspaces-try-apps:latest
ctr=wad-try-apps
podman image exists localhost/wadspaces-base:trixie || { echo "no base: images/build.sh --only base" >&2; exit 1; }

# The catalog's apps (crates/wad-core/data/catalog.json): how each installs
# and the launcher it puts on the desktop.
apps=("$@")
[[ ${#apps[@]} -gt 0 ]] || mapfile -t apps < <(python3 -I -c '
import json, sys
for a in json.load(open(sys.argv[1]))["apps"]: print(a["id"])' "$root/crates/wad-core/data/catalog.json")
plan=$(python3 -I - "$root/crates/wad-core/data/catalog.json" "${apps[@]}" <<'PY'
import json, sys
cat = {a["id"]: a for a in json.load(open(sys.argv[1]))["apps"]}
features, apt, launchers = [], [], []
for id in sys.argv[2:]:
    i = cat[id]["install"]
    if i["kind"] == "feature": features.append(i["feature"])
    if i["kind"] == "apt":
        apt.append(f"wadspaces-apt {i['id']} --desktop {i['desktop'][0]} {' '.join(i['packages'])}")
    launchers.append(f"{id}={i['desktop'][0]}")
print("FEATURES=" + " ".join(features))
print("APT=" + " && ".join(apt))
print("LAUNCHERS=" + " ".join(launchers))
PY
)
eval "$(sed 's/=\(.*\)/="\1"/' <<<"$plan")"

rm -rf "$dir" && mkdir -p "$dir/build"
# This checkout's feature scripts and helpers over the base's, so a fix is
# tried without rebuilding the base.
cp -r "$root/images/base/root/usr/local/lib/wadspaces/features" "$dir/build/features"
cp "$root/images/base/root/usr/local/bin/"wadspaces-* "$dir/build/"
{
  echo "FROM localhost/wadspaces-base:trixie"
  echo "COPY features/ /usr/local/lib/wadspaces/features/"
  echo "COPY wadspaces-* /usr/local/bin/"
  echo "RUN chmod +x /usr/local/bin/wadspaces-* /usr/local/lib/wadspaces/features/*.sh"
  # One RUN each: a failed app leaves the ones before it cached for the retry.
  for f in $FEATURES; do echo "RUN wadspaces-feature $f"; done
  [[ -n "$APT" ]] && echo "RUN $APT && wadspaces-apt --clean"
  echo "RUN printf '%s' '{\"version\":1,\"icons\":[$(for l in $LAUNCHERS; do printf '{"app":"%s","desktop":"%s","label":"%s"},' "${l%%=*}" "${l#*=}" "${l%%=*}"; done | sed 's/,$//')]}' > /etc/wadspaces/layout.json"
} >"$dir/build/Dockerfile"
cat "$dir/build/Dockerfile"
echo "== building (the apps download now; the first build takes a while)"
podman build -t "$img" "$dir/build" 2>&1 | tee "$dir/build.log" | grep -E '^(STEP|\*\*\*\*|.*error|.*Error)' || true
podman image exists "$img" || { echo "the build failed: $dir/build.log" >&2; exit 1; }

. "$root/apps/wadd/dev/sway.sh"
start_sway "$dir"
uid=$(id -u)
finish() {
  if [[ -z "${KEEP:-}" ]]; then podman rm -f "$ctr" >/dev/null 2>&1 || true; podman rmi -i "$img" >/dev/null 2>&1 || true; fi
  stop_sway
}
trap finish EXIT
grim_bin=$(command -v grim || echo "$root/.build/sway/usr/bin/grim")
shot() { env XDG_RUNTIME_DIR="$rt" WAYLAND_DISPLAY=wayland-1 ${libs:+LD_LIBRARY_PATH=$libs} "$grim_bin" "$1"; }

# As wadd runs a wadspace on a laptop (wad-core's rootless quadlet): you are
# abc (uid 1000) inside, the screen and sound are your session's.
maps=()
for m in "0:1:$uid" "$uid:0:1" "$((uid + 1)):$((uid + 1)):$((65536 - uid - 1))"; do maps+=(--uidmap "$m" --gidmap "$m"); done
podman rm -f "$ctr" >/dev/null 2>&1 || true
podman run -d --name "$ctr" "${maps[@]}" --security-opt label=disable --shm-size 1g \
  $( [[ -e /dev/dri ]] && echo --device /dev/dri ) \
  -v "$XDG_RUNTIME_DIR:/run/wadspaces-display" \
  -e PUID=1000 -e PGID=1000 -e TZ=Pacific/Fiji -e TITLE="Try apps" \
  -e WADSPACES_WAYLAND="$rt_name/wayland-1" \
  -e PULSE_SERVER=unix:/run/wadspaces-display/pulse/native \
  "$img" >/dev/null
# The machine's sway puts new windows on a "pending" workspace (wadd shows
# them): show that one.
for _ in $(seq 120); do [ -n "$(where)" ] && break; sleep 0.5; done
sm 'workspace pending' >/dev/null
sleep 8
shot "$dir/desktop.png" && echo "  desktop: $dir/desktop.png"

# Each launcher, as abc in the desktop's own session (labwc's environment).
for l in $LAUNCHERS; do
  app=${l%%=*} desk=${l#*=}
  echo "== $app ($desk)"
  podman exec -u abc "$ctr" sh -c '
    # The environment of the desktop panel: what its launchers start apps
    # with (the display of labwc, and Xwayland for X11 apps).
    pid=$(pgrep -u abc -x selkies-desktop | head -1)
    eval "$(tr "\0" "\n" < /proc/$pid/environ | grep -E "^(WAYLAND_DISPLAY|DISPLAY|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS)=" | sed "s/^/export /")"
    cd /config
    ps -o pid= -u abc > /tmp/before-$2
    test -f "/usr/share/applications/$1" || { echo "  no launcher /usr/share/applications/$1"; exit 1; }
    grep -E "^(Exec|Icon)=" "/usr/share/applications/$1" | sed "s/^/  /"
    gio launch "/usr/share/applications/$1" > "/tmp/$2.log" 2>&1 &' sh "$desk" "$app" || continue
  sleep "${WAIT:-25}"
  podman exec -u abc "$ctr" sh -c 'ps -o pid,rss,args -u abc | grep -v -E "ps -o|grep|labwc|selkies|dbus|swaybg|wadspaces-clip|sh -c" | tail -n +2 | cut -c1-110 | sed "s/^/  | /"; tail -n 4 "/tmp/$1.log" | sed "s/^/  log: /"' sh "$app" || true
  shot "$dir/$app.png" && echo "  screenshot: $dir/$app.png"
  # Close what it opened (what wasn't running before it), for the next one.
  podman exec -u abc "$ctr" sh -c 'for p in $(ps -o pid= -u abc); do
      grep -qx " *$p" "/tmp/before-$1" || kill -9 "$p" 2>/dev/null
    done' sh "$app" || true
  sleep 2
done
echo "== container log (last lines)"
podman logs "$ctr" 2>&1 | tail -n 15
