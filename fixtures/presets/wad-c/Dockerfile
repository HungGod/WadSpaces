# Wad Creator workspace: developing the Wad Creator web app (Firebase).
ARG BASE_IMAGE=localhost/wadspaces-base:trixie
FROM ${BASE_IMAGE}

ENV TITLE="Wad Creator"

RUN wadspaces-feature git nodejs firebase vscode claude-code chrome

RUN wadspaces-webapp "Claude" https://claude.ai && \
    wadspaces-webapp "GitHub" https://github.com && \
    wadspaces-webapp "Google Cloud" https://console.cloud.google.com && \
    wadspaces-webapp "OpenRouter" https://openrouter.ai

COPY root/ /
