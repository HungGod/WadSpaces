# IntelligenceQuest dev workspace: C++ game development. Its sites are web
# apps, each a WadBrowser window (built by hand, they get cards with their
# sites' names; a WadSpaces Client build brings their own icons).
ARG BASE_IMAGE=localhost/wadspaces-base:trixie
FROM ${BASE_IMAGE}

ENV TITLE="IntelligenceQuest Dev"

RUN wadspaces-feature git cpp python nodejs vscode claude-code tiled

RUN wadspaces-webapp --id spritesheet-packer "Spritesheet Packer" https://www.codeandweb.com/free-sprite-sheet-packer && \
    wadspaces-webapp --id github "Github" https://github.com && \
    wadspaces-webapp --id claude "Claude" https://claude.ai && \
    wadspaces-webapp --id piskel "Piskel" https://www.piskelapp.com/
