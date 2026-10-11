#!/usr/bin/env bash
# wadspaces-signins (the image's sign-in linker) against folders in a temp
# dir, as you: adopting, linking, a second wadspace, setting aside, a write
# by rename, unlinking. Prints "ok" or what went wrong.
#
#   images/base/try-signins.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
LINKER="${HERE}/root/usr/local/bin/wadspaces-signins"
T="$(mktemp -d)"
trap 'rm -rf "${T}"' EXIT
export WADSPACES_SIGNINS_ROOT="${T}/mnt" WADSPACES_SIGNINS_USER="$(id -un)"
mkdir -p "${T}/mnt/code" "${T}/a" "${T}/b"

manifest() { # paths...
    local paths
    paths="$(printf '"%s",' "$@")"
    printf '{"version":1,"signins":[{"id":"code","name":"VS Code","web":false,"apps":["vscode"],"dir":"%s","paths":[%s]}]}' \
        "${T}/mnt/code" "${paths%,}" > "${T}/signins.json"
}
run() { WADSPACES_SIGNINS_MANIFEST="${T}/signins.json" "${LINKER}" "$1" "$1/.wadspaces" > /dev/null; }
fail() { echo "FAILED: $*"; exit 1; }
is_link() { [[ -L "$1" && "$(readlink "$1")" == "$2" ]] || fail "$1 isn't a link to $2"; }

# Wadspace a was signed in already: its folder moves into the sign-in.
mkdir -p "${T}/a/.config/Code/User/globalStorage"
echo token-a > "${T}/a/.config/Code/User/globalStorage/state.vscdb"
manifest ".config/Code/User/globalStorage/" ".claude.json"
run "${T}/a"
is_link "${T}/a/.config/Code/User/globalStorage" "${T}/mnt/code/.config/Code/User/globalStorage"
[[ "$(cat "${T}/mnt/code/.config/Code/User/globalStorage/state.vscdb")" == token-a ]] || fail "not adopted"
# A file neither had: a link the app can create through.
is_link "${T}/a/.claude.json" "${T}/mnt/code/.claude.json"
echo '{"a":1}' > "${T}/a/.claude.json"
[[ -f "${T}/mnt/code/.claude.json" ]] || fail "writing through the link"

# Wadspace b had its own: set aside; it sees a's sign-in.
mkdir -p "${T}/b/.config/Code/User/globalStorage"
echo token-b > "${T}/b/.config/Code/User/globalStorage/state.vscdb"
run "${T}/b"
[[ "$(cat "${T}/b/.config/Code/User/globalStorage/state.vscdb")" == token-a ]] || fail "b doesn't see the sign-in"
[[ "$(cat "${T}/b/.config/Code/User/globalStorage.wadspaces-local/state.vscdb")" == token-b ]] || fail "b's own not kept"

# An app wrote over the link by rename: the newer copy goes into the sign-in.
sleep 1
rm "${T}/b/.claude.json" && echo '{"b":2}' > "${T}/b/.claude.json"
run "${T}/b"
is_link "${T}/b/.claude.json" "${T}/mnt/code/.claude.json"
[[ "$(cat "${T}/a/.claude.json")" == '{"b":2}' ]] || fail "the newer copy didn't win"

# Starting again changes nothing.
run "${T}/a"
is_link "${T}/a/.config/Code/User/globalStorage" "${T}/mnt/code/.config/Code/User/globalStorage"

# The Builder's kinds (wad-core's signins.rs): each path through the linker,
# folders and files, adopted from a signed-in wadspace and seen by another.
kind() { # id paths...
    local id=$1; shift
    local paths; paths="$(printf '"%s",' "$@")"
    mkdir -p "${T}/mnt/${id}"
    printf '{"version":1,"signins":[{"id":"%s","name":"%s","web":false,"apps":["x"],"dir":"%s","paths":[%s]}]}' \
        "${id}" "${id}" "${T}/mnt/${id}" "${paths%,}" > "${T}/signins.json"
}
for spec in \
    "claude .claude/ .claude.json" \
    "codex .codex/" \
    "steam .steam/ .local/share/Steam/config/ .local/share/Steam/userdata/"; do
    read -r id rest <<< "${spec}"
    read -ra paths <<< "${rest}"
    rm -rf "${T}/c" "${T}/d" && mkdir -p "${T}/c" "${T}/d"
    kind "${id}" "${paths[@]}"
    for p in "${paths[@]}"; do
        if [[ "${p}" == */ ]]; then mkdir -p "${T}/c/${p}" && echo "${id}" > "${T}/c/${p}token"
        else mkdir -p "$(dirname "${T}/c/${p}")" && echo "${id}" > "${T}/c/${p}"; fi
    done
    run "${T}/c"
    run "${T}/d"
    for p in "${paths[@]}"; do
        f="${p}"; [[ "${p}" == */ ]] && f="${p}token"
        is_link "${T}/d/${p%/}" "${T}/mnt/${id}/${p%/}"
        [[ "$(cat "${T}/d/${f}")" == "${id}" ]] || fail "${id}: ${p} isn't shared"
    done
done
manifest ".config/Code/User/globalStorage/" ".claude.json"

# No longer wanted: the links go, b's own comes back.
printf '{"version":1,"signins":[]}' > "${T}/signins.json"
run "${T}/b"
[[ ! -L "${T}/b/.claude.json" && ! -e "${T}/b/.claude.json" ]] || fail "b's link stayed"
[[ "$(cat "${T}/b/.config/Code/User/globalStorage/state.vscdb")" == token-b ]] || fail "b's own didn't come back"
[[ "$(cat "${T}/mnt/code/.config/Code/User/globalStorage/state.vscdb")" == token-a ]] || fail "the sign-in lost its files"
echo ok
