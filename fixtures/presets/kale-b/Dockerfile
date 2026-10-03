# Kale Browser workspace: KaleBrowser development.
ARG BASE_IMAGE=localhost/wadspaces-base:trixie
FROM ${BASE_IMAGE}

ARG KALEBROWSER_REF=main
ENV TITLE="Kale Browser"

RUN wadspaces-feature git python nodejs vscode claude-code kalebrowser

COPY root/ /

RUN wadspaces-kalebrowser-install --ref "${KALEBROWSER_REF}" \
      --resources /etc/wadspaces/kalebrowser-resources.json
