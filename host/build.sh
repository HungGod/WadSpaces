#!/usr/bin/env bash
# Build the WadSpaces host image, and optionally a bootable disk.
#
#   host/build.sh image            container image localhost/wadspaces-host:latest
#   host/build.sh qcow2 | iso      image + disk via bootc-image-builder (sudo)
#   host/build.sh install /dev/sdX image + `bootc install to-disk` onto that drive
#                                  (WIPES it; sudo; refuses the disk holding /)
#   host/build.sh update /dev/sdX  image, copied onto an already installed drive
#                                  in place: only changed layers are written, and
#                                  the drive switches to it on its next boot (sudo)
#
#   --images writing,iq-dev        with install/update: also copy these locally
#                                  built workspace images onto the drive, so the
#                                  machine never downloads them
#   --bases                        with install/update: also copy the base images
#                                  (localhost/wadspaces-{base,stream,selkies}:trixie)
#                                  onto the drive; the machine's own builds need
#                                  them and it can't download them
#   --stage-only DIR               with update: write what would go onto the
#                                  drive into DIR instead (for testing)
#
# WADCREATOR_DIR (default apps/wadcreator): Wad Creator, the kiosk's shell. Its
# Tauri app (npm run build:app) goes into the image at /usr/bin/wadcreator. It
# needs Rust (rustup), Node, the WebKitGTK dev packages, and the Firebase web
# config in WADCREATOR_DIR/.env.local.
#
# wadd (apps/wadd, the machine daemon) and the HUD (apps/hud: the bar, power
# and Wi-Fi menus and the switcher above every window) are built here too,
# into /usr/bin/wadd and /usr/libexec/wadspaces/hud. The HUD needs gtk4-devel
# and gtk4-layer-shell-devel.
#
# Baked-in secrets come from host/secrets/ (gitignored, never in the build
# context directly):
#   admin_password_hash    crypt hash for `admin` (default: the one in bib-config.toml)
# No GitHub token is baked in any more: each machine signs in to GitHub from
# Wad Creator (device sign-in), and gets the token from the account.
# ADMIN_SSH_KEY (default: the key in bib-config.toml) is admin's SSH key.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${IMAGE:-localhost/wadspaces-host:latest}"
WADCREATOR_DIR="${WADCREATOR_DIR:-${ROOT}/apps/wadcreator}"
SECRETS_DIR="${ROOT}/host/secrets"
BIB_CONFIG="${ROOT}/host/bib-config.toml"
TARGET="${1:-image}"
DISK=""
IMAGES=""
BASES=""
STAGE_ONLY=""
[[ $# -gt 0 ]] && shift
if [[ "${TARGET}" == "install" || "${TARGET}" == "update" ]] && [[ $# -gt 0 && "$1" != --* ]]; then
    DISK="$1"; shift
fi
while [[ $# -gt 0 ]]; do
    case "$1" in
        --images) IMAGES="$2"; shift 2 ;;
        --bases) BASES=1; shift ;;
        --stage-only) STAGE_ONLY="$2"; shift 2 ;;
        *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
done
STICK_OCI="${ROOT}/.build/stick/oci"
# The workspace images (their Dockerfiles and compose files).
CONTAINERS_DIR="${CONTAINERS_DIR:-${ROOT}/../Wadspaces-David}"

# Built here rather than in a container: this laptop runs Fedora 43 like the
# image, so the app links against the same WebKitGTK. The image build runs
# `wadcreator --version` to check that it loads.
stage_wadcreator() {
    local out="${ROOT}/.build/wadcreator-app"
    rm -rf "${out}" && mkdir -p "${out}"
    if ! command -v cargo > /dev/null && [[ -f "${HOME}/.cargo/env" ]]; then
        # shellcheck disable=SC1091
        source "${HOME}/.cargo/env"
    fi
    command -v cargo > /dev/null || { echo "cargo not found: install Rust with rustup" >&2; exit 1; }
    [[ -f "${WADCREATOR_DIR}/.env.local" ]] || { echo "no ${WADCREATOR_DIR}/.env.local: Wad Creator needs the Firebase web config (see .env.example)" >&2; exit 1; }
    echo ">> building Wad Creator (Tauri) in ${WADCREATOR_DIR}"
    (cd "${WADCREATOR_DIR}" && npm ci --no-audit --no-fund && npm run build:app)
    install -m 755 "${ROOT}/target/release/wadcreator" "${out}/wadcreator"
}

stage_wadd() {
    local out="${ROOT}/.build/wadd"
    rm -rf "${out}" && mkdir -p "${out}"
    echo ">> building wadd (apps/wadd)"
    (cd "${ROOT}" && cargo build --release --quiet -p wadd)
    install -m 755 "${ROOT}/target/release/wadd" "${out}/wadd"
}

stage_hud() {
    local out="${ROOT}/.build/hud"
    rm -rf "${out}" && mkdir -p "${out}"
    echo ">> building the HUD (apps/hud)"
    (cd "${ROOT}" && cargo build --release --quiet -p wadspaces-hud)
    install -m 755 "${ROOT}/target/release/wadspaces-hud" "${out}/hud"
}

# admin's password hash or SSH key from bib-config.toml ("password" / "key").
bib_admin() {
    python3 - "${BIB_CONFIG}" "$1" <<'EOF'
import sys, tomllib
with open(sys.argv[1], "rb") as f:
    users = tomllib.load(f).get("customizations", {}).get("user", [])
print(next((u.get(sys.argv[2], "") for u in users if u.get("name") == "admin"), ""))
EOF
}

stage_secrets() {
    local out="${ROOT}/.build/secrets"
    rm -rf "${out}" && (umask 077 && mkdir -p "${out}")
    local hash
    if [[ -f "${SECRETS_DIR}/admin_password_hash" ]]; then
        hash="$(< "${SECRETS_DIR}/admin_password_hash")"
    else
        hash="$(bib_admin password)"
    fi
    # bib-config.toml may hold the password itself rather than a crypt hash
    # (bootc-image-builder takes either); usermod -p needs the hash. The salt
    # comes from the password so the same password gives the same hash on
    # every build, and the machine only re-applies it when it changes.
    if [[ -n "${hash}" && "${hash}" != \$*\$*\$* ]]; then
        local salt
        salt="$(printf 'wadspaces-admin:%s' "${hash}" | sha256sum | cut -c1-16)"
        hash="$(printf '%s' "${hash}" | openssl passwd -6 -salt "${salt}" -stdin)"
    fi
    if [[ -n "${hash}" ]]; then
        (umask 077 && printf '%s' "${hash}" > "${out}/admin_password_hash")
    else
        echo ">> WARNING: no admin password hash; admin can only log in with the SSH key"
    fi

    local ssh="${ROOT}/.build/ssh"
    rm -rf "${ssh}" && mkdir -p "${ssh}"
    if [[ -n "${ADMIN_SSH_KEY:-}" ]]; then
        cp "${ADMIN_SSH_KEY}" "${ssh}/admin"
    else
        bib_admin key > "${ssh}/admin"
    fi
    [[ -s "${ssh}/admin" ]] || echo ">> WARNING: no admin SSH key"
}

# The whole-disk device behind /, so `install` can refuse it.
root_disk() {
    local src
    src="$(findmnt -no SOURCE -T / | sed 's/\[.*//')"
    lsblk -ndo PKNAME "${src}" 2>/dev/null | sed 's|^|/dev/|' || true
}

check_disk() {
    [[ -n "${DISK}" && -b "${DISK}" ]] || { echo "usage: host/build.sh ${TARGET} /dev/sdX" >&2; exit 2; }
    [[ "$(lsblk -ndo TYPE "${DISK}")" == "disk" ]] || { echo "${DISK} is not a whole disk" >&2; exit 2; }
    if [[ "$(realpath "${DISK}")" == "$(realpath "$(root_disk)" 2>/dev/null)" ]]; then
        echo "${DISK} holds this system's root filesystem; refusing" >&2; exit 2
    fi
    if lsblk -nro MOUNTPOINTS "${DISK}" | grep -q .; then
        echo "${DISK} has mounted partitions; unmount them first" >&2; exit 2
    fi
}

check_install_target() {
    check_disk
    lsblk -o NAME,SIZE,MODEL,TRAN "${DISK}"
    read -r -p "Everything on ${DISK} will be erased. Type the device path to continue: " answer
    [[ "${answer}" == "${DISK}" ]] || { echo "aborted"; exit 1; }
}

# The WadSpaces root partition (label "root", xfs) on an installed drive.
root_partition() {
    lsblk -nrpo NAME,FSTYPE,LABEL "${DISK}" | awk '$2 == "xfs" && $3 == "root" { print $1; exit }'
}

check_update_target() {
    check_disk
    [[ -n "$(root_partition)" ]] || {
        echo "${DISK} has no WadSpaces root partition; use install first" >&2; exit 2; }
    lsblk -o NAME,SIZE,MODEL,TRAN,LABEL "${DISK}"
}

# ------------------------------------------------------------ drive updates
# What goes onto the drive: an OCI directory holding the host image ("host"),
# workspace images ("ws-<id>") and base images ("base-<name>"), with layers left
# uncompressed, so a file name is its content digest and stays the same in every
# build that didn't change it.
# rsync then writes only new layers. On the drive, wadspaces-import.service
# (host/usr/libexec/wadspaces/import-updates) imports them at the next boot.

# "writing" -> "cosmic-bodybuilding" (the wadspaces.id label in its compose file)
workspace_dir() {
    local f
    for f in "${CONTAINERS_DIR}"/*/docker-compose.yml; do
        if grep -qE "^[[:space:]]*wadspaces\.id:[[:space:]]*$1[[:space:]]*$" "$f"; then
            basename "$(dirname "$f")"; return
        fi
    done
    [[ -f "${CONTAINERS_DIR}/$1/Dockerfile" ]] && { echo "$1"; return; }
    echo "no workspace $1 in ${CONTAINERS_DIR}" >&2; return 1
}

# The image name wadd runs a workspace as (image = in the image's
# workspaces.d/<id>.toml).
workspace_target() {
    python3 -c '
import sys, tomllib
try:
    print(tomllib.load(open(sys.argv[1], "rb"))["image"])
except FileNotFoundError:
    sys.exit(sys.argv[2] + " is not one of the image'"'"'s workspaces (host/usr/lib/wadspaces/workspaces.d)")
' "${ROOT}/host/usr/lib/wadspaces/workspaces.d/$1.toml" "$1"
}

stage_stick() {
    rm -rf "${STICK_OCI}" && mkdir -p "${STICK_OCI}"
    : > "${STICK_OCI}/import.list"
    if [[ "${TARGET}" == "update" ]]; then
        echo ">> staging ${IMAGE} for the drive"
        skopeo copy -q --dest-oci-accept-uncompressed-layers "containers-storage:${IMAGE}" "oci:${STICK_OCI}:host"
        podman image inspect --format '{{.Id}}' "${IMAGE}" > "${STICK_OCI}/host.id"
    fi
    local id dir src target
    for id in ${IMAGES//,/ }; do
        dir="$(workspace_dir "${id}")"
        src="localhost/wadspaces-${dir}:latest"
        target="$(workspace_target "${id}")"
        podman image exists "${src}" || { echo "${src} is not built; run containers/build.sh --only ${id}" >&2; exit 1; }
        echo ">> staging ${src} as ${target}"
        skopeo copy -q --dest-oci-accept-uncompressed-layers "containers-storage:${src}" "oci:${STICK_OCI}:ws-${id}"
        echo "ws-${id} ${target}" >> "${STICK_OCI}/import.list"
    done
    # Bases keep their own names: wadd builds on them as they are.
    local b
    for b in ${BASES:+base stream selkies}; do
        src="localhost/wadspaces-${b}:trixie"
        podman image exists "${src}" || { echo "${src} is not built; run containers/build.sh --only _${b/base/common}" >&2; exit 1; }
        echo ">> staging ${src}"
        skopeo copy -q --dest-oci-accept-uncompressed-layers "containers-storage:${src}" "oci:${STICK_OCI}:base-${b}"
        echo "base-${b} ${src}" >> "${STICK_OCI}/import.list"
    done
    du -sh "${STICK_OCI}" | awk '{print ">> staged " $1}'
}

# Mount the drive's root, mirror the staged directory into its /var, mark it.
push_to_drive() {
    local part mnt var
    part="$(root_partition)"
    mnt="$(mktemp -d)"
    sudo mount "${part}" "${mnt}"
    trap "sudo umount '${mnt}' 2>/dev/null; rmdir '${mnt}' 2>/dev/null" EXIT
    var="$(sudo sh -c "ls -d '${mnt}'/ostree/deploy/*/var" | head -n1)"
    [[ -n "${var}" ]] || { echo "no ostree deployment on ${part}" >&2; exit 1; }
    echo ">> copying changed layers to ${DISK}"
    sudo mkdir -p "${var}/lib/wadspaces/incoming"
    sudo rsync -rt --delete --info=progress2 "${STICK_OCI}/" "${var}/lib/wadspaces/incoming/"
    sudo touch "${var}/lib/wadspaces/incoming/pending"
    echo ">> flushing to the drive"
    sync
    sudo umount "${mnt}" && rmdir "${mnt}"
    trap - EXIT
}

copy_to_root_storage() {
    if [[ $EUID -ne 0 ]]; then
        echo ">> copying ${IMAGE} into root's container storage"
        podman image scp "${USER}@localhost::${IMAGE}" root@localhost::
    fi
}

case "${TARGET}" in
    image|qcow2|iso|raw) ;;
    install) check_install_target ;;
    update) [[ -n "${STAGE_ONLY}" ]] || check_update_target ;;
    *) echo "usage: host/build.sh [image|qcow2|iso|raw|install /dev/sdX|update /dev/sdX] [--images a,b] [--bases]" >&2; exit 2 ;;
esac

stage_wadcreator
stage_wadd
stage_hud
stage_secrets
echo ">> building ${IMAGE}"
podman build -f "${ROOT}/host/Containerfile" -t "${IMAGE}" "${ROOT}"

case "${TARGET}" in
    image) ;;
    qcow2|iso|raw)
        mkdir -p "${ROOT}/output"
        # bootc-image-builder reads the image from root's storage.
        copy_to_root_storage
        sudo podman run --rm -it --privileged --pull=newer \
            --security-opt label=type:unconfined_t \
            -v "${ROOT}/output:/output" \
            -v /var/lib/containers/storage:/var/lib/containers/storage \
            -v "${BIB_CONFIG}:/config.toml:ro" \
            quay.io/centos-bootc/bootc-image-builder:latest \
            --type "${TARGET}" --rootfs xfs --config /config.toml "${IMAGE}"
        echo ">> disk image in ${ROOT}/output/"
        ;;
    install)
        copy_to_root_storage
        echo ">> installing ${IMAGE} to ${DISK}"
        sudo podman run --rm --privileged --pid=host \
            --security-opt label=type:unconfined_t \
            -v /dev:/dev -v /var/lib/containers:/var/lib/containers \
            "${IMAGE}" bootc install to-disk --wipe "${DISK}"
        if [[ -n "${IMAGES}" || -n "${BASES}" ]]; then
            # The host image is installed already; only the workspaces and bases go over.
            stage_stick
            push_to_drive
        fi
        echo ">> done; boot the Surface from USB (hold Volume-down, press Power)"
        ;;
    update)
        stage_stick
        if [[ -n "${STAGE_ONLY}" ]]; then
            mkdir -p "${STAGE_ONLY}"
            rsync -rt --delete "${STICK_OCI}/" "${STAGE_ONLY}/"
            touch "${STAGE_ONLY}/pending"
            echo ">> staged into ${STAGE_ONLY}"
        else
            push_to_drive
            echo ">> done; boot ${DISK}: it imports the update, then restarts once into it"
        fi
        ;;
esac
