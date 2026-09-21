#!/usr/bin/env bash
# Build the WadSpaces host image, and optionally a bootable disk.
#
#   host/build.sh image            container image localhost/wadspaces-host:latest
#   host/build.sh qcow2 | iso      image + disk via bootc-image-builder (sudo)
#
# WADCREATOR_DIR (default ../WadCreator) is built with `npm run build` and its
# dist/ is served by wadd on 127.0.0.1:8081. Without it a placeholder is used.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${IMAGE:-localhost/wadspaces-host:latest}"
WADCREATOR_DIR="${WADCREATOR_DIR:-${ROOT}/../WadCreator}"
TARGET="${1:-image}"

stage_wadcreator() {
    local out="${ROOT}/.build/wadcreator"
    rm -rf "${out}" && mkdir -p "${out}"
    if [[ -f "${WADCREATOR_DIR}/package.json" ]]; then
        echo ">> building Wad Creator in ${WADCREATOR_DIR}"
        (cd "${WADCREATOR_DIR}" && npm ci --no-audit --no-fund && npm run build)
        cp -r "${WADCREATOR_DIR}/dist/." "${out}/"
    else
        echo ">> no Wad Creator at ${WADCREATOR_DIR}; shipping a placeholder"
        printf '<!doctype html><title>Wad Creator</title><body style="background:#0b0b14;color:#ecebf5;font-family:sans-serif;display:grid;place-items:center;height:100vh"><p>Wad Creator is not installed in this image.</p>' \
            > "${out}/index.html"
    fi
}

stage_wadcreator
echo ">> building ${IMAGE}"
podman build -f "${ROOT}/host/Containerfile" -t "${IMAGE}" "${ROOT}"

case "${TARGET}" in
    image) ;;
    qcow2|iso|raw)
        mkdir -p "${ROOT}/output"
        # bootc-image-builder reads the image from root's storage.
        if [[ $EUID -ne 0 ]]; then
            echo ">> copying ${IMAGE} into root's container storage"
            podman image scp "${USER}@localhost::${IMAGE}" root@localhost::
        fi
        sudo podman run --rm -it --privileged --pull=newer \
            --security-opt label=type:unconfined_t \
            -v "${ROOT}/output:/output" \
            -v /var/lib/containers/storage:/var/lib/containers/storage \
            -v "${ROOT}/host/bib-config.toml:/config.toml:ro" \
            quay.io/centos-bootc/bootc-image-builder:latest \
            --type "${TARGET}" --rootfs xfs --config /config.toml "${IMAGE}"
        echo ">> disk image in ${ROOT}/output/"
        ;;
    *) echo "usage: host/build.sh [image|qcow2|iso|raw]" >&2; exit 2 ;;
esac
