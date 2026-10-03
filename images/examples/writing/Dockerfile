# Writing workspace: Obsidian + the HungGod/Writing vault.
#
# Everything generic (git auth, the mounted projects, desktop launchers,
# wallpaper, blanked Selkies icon) comes from the WadSpaces base image in
# ../../base. This image adds Obsidian and pins the vault.
ARG BASE_IMAGE=localhost/wadspaces-base:trixie
FROM ${BASE_IMAGE}

ARG OBSIDIAN_VERSION=""
LABEL maintainer="dwadsworth"

ENV TITLE="Writing" \
    AUTOSTART_OBSIDIAN=false \
    VAULT_DIR="/config/Desktop/Writing" \
    PIN_VAULT=true

RUN OBSIDIAN_VERSION="${OBSIDIAN_VERSION}" wadspaces-feature git obsidian

COPY root/ /

# host permission bits are not reliable across clones
RUN chmod +x /etc/s6-overlay/s6-rc.d/init-writing-vault/run
