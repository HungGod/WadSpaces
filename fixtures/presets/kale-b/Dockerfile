# Kale Browser workspace: KaleBrowser development. Its sites are web apps,
# each a WadBrowser window (the base image has WadBrowser).
ARG BASE_IMAGE=localhost/wadspaces-base:trixie
FROM ${BASE_IMAGE}

ENV TITLE="Kale Browser"

RUN wadspaces-feature git python nodejs vscode claude-code

RUN wadspaces-webapp "Github" https://github.com && \
    wadspaces-webapp "Claude" https://claude.ai && \
    wadspaces-webapp "Open Router" https://openrouter.ai/

COPY root/ /
