# WadSpaces stream sidecar.
#
# Runs next to a lean workspace (see ../base/) when it is used remotely: this
# container is only the Selkies stream (pixelflux compositor, encoder, web
# client on :3000). It runs no desktop of its own; its Wayland socket goes in
# a volume shared with the workspace at /run/wadspaces-display, and the
# workspace's labwc draws on it.
#
# One image serves every workspace. See cosmic-bodybuilding/docker-compose.yml.
FROM ghcr.io/linuxserver/baseimage-selkies:debiantrixie

ARG BUILD_DATE
ARG VERSION
LABEL build_version="WadSpaces stream version:- ${VERSION} Build-date:- ${BUILD_DATE}"
LABEL maintainer="dwadsworth"
LABEL org.opencontainers.image.source="https://github.com/HungGod/Workspace-Switcher"

ENV TITLE="WadSpaces" \
    NO_GAMEPAD=true \
    PIXELFLUX_WAYLAND=true

RUN \
  echo "**** blank the selkies start icon ****" && \
  printf '%s' \
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNgYGBgAAAABQABeqhXUAAAAABJRU5ErkJggg==' \
    | base64 -d > /usr/share/selkies/www/icon.png

COPY root/ /
RUN chmod +x /etc/s6-overlay/s6-rc.d/*/run

EXPOSE 3000
