# WadSpaces workspace base image (lean).
#
# A workspace is one image that runs both locally and remotely; only how it is
# run differs. The image holds the desktop (labwc + Xwayland + the
# selkies-desktop icon panel) and the apps, and labwc draws as one window on
# whatever Wayland compositor is mounted at /run/wadspaces-display:
#
#   local   the machine's own screen (wadd's `display: host`)
#   remote  the wadspaces-stream sidecar (../stream/), which streams it to
#           another device (wadd's streams, or the workspace's
#           docker-compose.yml)
#
# A workspace is described by data files in /etc/wadspaces instead of its own
# init script:
#
#   /etc/wadspaces/layout.json           the desktop's icons, in order (Wad Creator)
#   /etc/wadspaces/desktop-entries.list  .desktop files to seed into ~/Desktop
#                                        (hand-written images without a layout)
#   /etc/wadspaces/chown.list            paths handed to abc at boot
#
# and build-time helpers install what goes in it:
#
#   wadspaces-feature <name>...          tools and apps (/usr/local/lib/wadspaces/features)
#   wadspaces-apt <id> [--desktop f] <pkg>...   a Debian desktop app
#   wadspaces-webapp [--id <id>] <name> <url>   a website in its own WadBrowser window
#
# WadBrowser (apps/wadbrowser) is the browser, every web app's window, and
# what links open in. It's built for trixie by images/build.sh, which passes
# it in as the `wadbrowser` build context (so build with that script).
#
# selkies-desktop lists ~/Desktop in readdir order; this shim sorts it by name
# so a designed desktop keeps its order (shim/sorted-desktop.c).
FROM docker.io/library/debian:trixie AS shim
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev && rm -rf /var/lib/apt/lists/*
COPY shim/sorted-desktop.c /src/
RUN gcc -shared -fPIC -O2 -Wall -Wextra -o /libsorted-desktop.so /src/sorted-desktop.c -ldl

FROM ghcr.io/linuxserver/baseimage-debian:trixie

ARG BUILD_DATE
ARG VERSION
LABEL build_version="WadSpaces base version:- ${VERSION} Build-date:- ${BUILD_DATE}"
LABEL maintainer="dwadsworth"
LABEL org.opencontainers.image.source="https://github.com/HungGod/Workspace-Switcher"

ENV HOME="/config" \
    TITLE="WadSpaces" \
    DESKTOP_DIR="/config/Desktop" \
    GITHUB_TOKEN_FILE="/run/secrets/github_token" \
    REFRESH_MENU=true \
    WALLPAPER="/usr/share/backgrounds/wallpaper.png" \
    WALLPAPER_MODE=center \
    WALLPAPER_COLOR="#0b0b14" \
    XCURSOR_THEME=breeze_cursors \
    XCURSOR_SIZE=24 \
    XKB_DEFAULT_LAYOUT=us \
    XKB_DEFAULT_RULES=evdev

RUN \
  echo "**** install packages ****" && \
  apt-get update && \
  DEBIAN_FRONTEND=noninteractive \
  apt-get install -y --no-install-recommends \
    breeze-cursor-theme \
    ca-certificates \
    dbus \
    dbus-user-session \
    fonts-noto-color-emoji \
    fonts-noto-core \
    foot \
    git \
    labwc \
    libcairo2 \
    libegl1 \
    libgl1-mesa-dri \
    libglib2.0-bin \
    libwayland-cursor0 \
    locales \
    mesa-va-drivers \
    mesa-vulkan-drivers \
    openssh-client \
    procps \
    python3-xdg \
    sudo \
    swaybg \
    unzip \
    wlr-randr \
    xdg-utils \
    xwayland \
    xz-utils && \
  echo "**** the locale the base image's LANG names ****" && \
  sed -i 's/^# *en_US.UTF-8 UTF-8/en_US.UTF-8 UTF-8/' /etc/locale.gen && \
  locale-gen && \
  echo "**** abc can sudo, as in the Selkies base ****" && \
  usermod -aG sudo abc && \
  echo "abc ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/abc && \
  chmod 440 /etc/sudoers.d/abc && \
  echo "**** cleanup ****" && \
  apt-get autoclean && \
  rm -rf \
    /var/lib/apt/lists/* \
    /var/tmp/* \
    /tmp/*

# The desktop icon/panel shell from the Selkies image. It is a plain Wayland
# client (cairo + libwayland), nothing to do with the stream. It starts apps
# with the first of dex, gio, gtk-launch it finds; the Selkies image has gio
# (libglib2.0-bin above), and its app menu only works through that.
COPY --from=ghcr.io/linuxserver/baseimage-selkies:debiantrixie /usr/bin/selkies-desktop /usr/bin/selkies-desktop

COPY root/ /
COPY --from=shim /libsorted-desktop.so /usr/local/lib/wadspaces/libsorted-desktop.so

RUN \
  chmod +x \
    /usr/local/bin/* \
    /usr/local/lib/wadspaces/features/*.sh \
    /etc/s6-overlay/s6-rc.d/*/run && \
  echo "**** selkies-desktop draws this as its centre logo: blank it ****" && \
  mkdir -p /usr/share/selkies/www && \
  printf '%s' \
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNgYGBgAAAABQABeqhXUAAAAABJRU5ErkJggg==' \
    | base64 -d > /usr/share/selkies/www/icon.png && \
  echo "**** check the desktop runs here ****" && \
  ! ldd /usr/bin/selkies-desktop | grep 'not found' && \
  labwc --version

# The GitHub CLI (wrapped by /usr/local/bin/gh to use the github_token secret).
# A layer of its own so adding it didn't rebuild the big install above.
RUN apt-get update && apt-get install -y --no-install-recommends gh && rm -rf /var/lib/apt/lists/*

# WadBrowser: WebKitGTK, and GStreamer to play media (va: the GPU decodes
# video; libav for what it can't), then the program itself. A layer of its
# own: the big install above stays cached.
RUN apt-get update && \
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    gstreamer1.0-gl \
    gstreamer1.0-libav \
    gstreamer1.0-plugins-bad \
    gstreamer1.0-plugins-base \
    gstreamer1.0-plugins-good \
    gstreamer1.0-pulseaudio \
    intel-media-va-driver \
    libwebkit2gtk-4.1-0 && \
  rm -rf /var/lib/apt/lists/*
COPY --from=wadbrowser bin/ /usr/local/bin/
COPY --from=wadbrowser icons/ /usr/share/icons/hicolor/
RUN \
  echo "**** links open in WadBrowser ****" && \
  update-alternatives --install /usr/bin/x-www-browser x-www-browser /usr/local/bin/wadbrowser-link 200 && \
  echo "**** check it runs here ****" && \
  ! ldd /usr/local/bin/wadbrowser | grep 'not found' && \
  wadbrowser --version && \
  wadspaces-icon --help > /dev/null
ENV BROWSER=/usr/local/bin/wadbrowser-link

# Project files are mounted by wadd at run time, never fetched by the image.
# wadd only mounts projects into images built on a base that says so: older
# bases clone repos over ~/Desktop at start, which would write over them.
LABEL io.wadspaces.projects="1"

VOLUME /config
