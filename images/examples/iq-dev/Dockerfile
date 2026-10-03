# IntelligenceQuest dev workspace: C++ game development.
ARG BASE_IMAGE=localhost/wadspaces-base:trixie
FROM ${BASE_IMAGE}

ARG KALEBROWSER_REF=main
ENV TITLE="IntelligenceQuest Dev"

RUN wadspaces-feature git cpp python nodejs vscode claude-code kalebrowser tiled

COPY root/ /

RUN wadspaces-kalebrowser-install --ref "${KALEBROWSER_REF}" \
      --resources /etc/wadspaces/kalebrowser-resources.json
