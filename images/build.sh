#!/usr/bin/env bash
# Build the images every workspace is made from. The workspaces themselves are
# built by wadd from WadSpaces Client's designs (or by hand from a downloaded build
# folder: `podman build -t localhost/wadspaces-<id>:latest .` in it).
#
#   images/build.sh                  the base
#   images/build.sh --only base      the same
#   images/build.sh --example writing   an example workspace (images/examples/):
#                                    localhost/wadspaces-writing:latest, the
#                                    bases first if they're missing
#   images/build.sh --no-cache       without podman's layer cache
#   images/build.sh --push           also tag and push to ghcr.io/hunggod
#
#   base    localhost/wadspaces-base:trixie    the lean desktop every workspace
#           builds on; its window goes on the machine's screen.
#           WadBrowser and the clipboard bridge are built for it first
#           (images/builder/: a Debian container with Rust; the first build
#           takes a while)
#
# host/build.sh install (or update --bases) copies it onto a machine's drive:
# the machine builds designs on it.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REGISTRY="${REGISTRY:-ghcr.io/hunggod}"
ALL=(base)
ONLY=()
EXAMPLES=()
NO_CACHE=false
PUSH=false

usage() { sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'; }

while [[ $# -gt 0 ]]; do
    case "$1" in
        --only) [[ $# -gt 1 && " ${ALL[*]} " == *" $2 "* ]] || { echo "--only base" >&2; exit 2; }
                ONLY+=("$2"); shift 2 ;;
        --example) [[ $# -gt 1 && -f "${HERE}/examples/$2/Dockerfile" ]] || {
                       echo "--example: one of $(ls "${HERE}/examples" | tr '\n' ' ')" >&2; exit 2; }
                   EXAMPLES+=("$2"); shift 2 ;;
        --no-cache) NO_CACHE=true; shift ;;
        --push) PUSH=true; shift ;;
        -h|--help) usage; exit 0 ;;
        *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
    esac
done
if [[ ${#EXAMPLES[@]} -gt 0 ]]; then
    # An example needs the base.
    for name in "${ALL[@]}"; do
        podman image exists "localhost/wadspaces-${name}:trixie" || ONLY+=("${name}")
    done
elif [[ ${#ONLY[@]} -eq 0 ]]; then
    ONLY=("${ALL[@]}")
fi

# Fail before a long build, not at the first push.
if ${PUSH} && ! podman login --get-login "${REGISTRY%%/*}" > /dev/null 2>&1; then
    echo "not logged in to ${REGISTRY%%/*}: podman login ${REGISTRY%%/*}" >&2
    exit 1
fi

ROOT="$(cd "${HERE}/.." && pwd)"
STAGE="${ROOT}/.build/wadbrowser"

# WadBrowser, wadspaces-icon and wadspaces-clipboard (crates/wad-clip: the
# wadspace's clipboard bridged to the machine's), built for trixie in a
# Debian container (a Fedora build would link another glibc and WebKitGTK),
# staged for the base image's `wadbrowser` build context with WadBrowser's
# icons. Cargo's caches
# live in podman volumes, so a rebuild only builds what changed.
build_wadbrowser() {
    echo ">> building localhost/wadspaces-builder:trixie from images/builder/"
    podman build -q -t localhost/wadspaces-builder:trixie "${HERE}/builder" > /dev/null
    echo ">> building WadBrowser for trixie (cargo, in the builder)"
    # label=disable, not :z: relabelling would rewrite the whole checkout.
    podman run --rm --security-opt label=disable \
        -v "${ROOT}":/src -w /src \
        -v wadspaces-cargo-registry:/usr/local/cargo/registry \
        -v wadspaces-target-trixie:/target -e CARGO_TARGET_DIR=/target \
        localhost/wadspaces-builder:trixie \
        sh -c 'cargo build --locked --profile wadbrowser -p wadbrowser -p wad-icons --features wad-icons/cli -p wad-clip &&
               cp /target/wadbrowser/wadbrowser /target/wadbrowser/wadspaces-icon /target/wadbrowser/wadspaces-clipboard \
                  /src/.build/wadbrowser/bin/'
    cp -r "${ROOT}/apps/wadbrowser/icons/hicolor/." "${STAGE}/icons/"
}

for name in "${ONLY[@]}"; do
    img="localhost/wadspaces-${name}:trixie"
    args=(--build-arg BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)" --build-arg VERSION="$(date -u +%Y%m%d)")
    ${NO_CACHE} && args+=(--no-cache)
    if [[ "${name}" == base ]]; then
        rm -rf "${STAGE}" && mkdir -p "${STAGE}/bin" "${STAGE}/icons"
        build_wadbrowser
        args+=(--build-context "wadbrowser=${STAGE}")
    fi
    echo ">> building ${img} from images/${name}/"
    podman build "${args[@]}" -t "${img}" "${HERE}/${name}"
    if ${PUSH}; then
        podman tag "${img}" "${REGISTRY}/wadspaces-${name}:trixie"
        podman push "${REGISTRY}/wadspaces-${name}:trixie"
    fi
done
for name in "${EXAMPLES[@]}"; do
    img="localhost/wadspaces-${name}:latest"
    args=()
    ${NO_CACHE} && args+=(--no-cache)
    echo ">> building ${img} from images/examples/${name}/"
    podman build "${args[@]}" -t "${img}" "${HERE}/examples/${name}"
done
echo ">> built: ${ONLY[*]} ${EXAMPLES[*]}"
