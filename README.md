# Wad Creator

The web app for designing and managing WadSpaces workspaces: pick apps, repos,
web apps and a wallpaper, then download a build folder or install the
workspace on this machine.

React + Vite + TypeScript + Tailwind, with Firebase (Auth, Firestore, Storage)
as an optional backend.

## How it runs today: locally, on each machine

Wad Creator is built into the WadSpaces host image and served by `wadd` on
`http://localhost:8081` (see `Workspace-Switcher/host/build.sh`). It calls
`wadd`'s API on `http://127.0.0.1:8080` directly:

| Page | Uses |
|---|---|
| This machine | live status over server-sent events; open, start, stop, restart, edit, remove |
| Workspaces | the library of saved designs; download a build folder |
| Editor | create or edit; "Install on this machine" writes the workspace into `/etc/wadspaces/workspaces.yaml` |
| Secrets | the machine's podman secret store; values never leave the machine |

"Install on this machine" registers the workspace; its image still has to be
built. Download the build folder, copy it to `WadSpaces/containers/<id>/`, and
run `containers/build.sh --only <id>`.

Later Wad Creator moves to wadcreator.com. Machines will then enrol with a
one-time code (`functions/src/index.ts`) and `wadd` will relay commands
through Firestore (`Workspace-Switcher/wadd/cloud.py`). The Firestore rules
for that are already in `firestore.rules`.

## Firebase is optional

Without `VITE_FIREBASE_*` in `.env.local` the app runs local-only: no sign-in,
and the library is kept in the browser. With Firebase configured, signing in
with Google keeps the library in `users/{uid}/workspaces` and wallpapers in
Storage. Sign-in uses a redirect rather than a popup, because the kiosk shows a
single fullscreen window.

```bash
cp .env.example .env.local   # fill in from Firebase console > Project settings
```

For sign-in on the machine, add `localhost` to Firebase Auth's authorized
domains (it is there by default).

## Develop

```bash
npm install
npm run dev          # http://localhost:8081, same port wadd uses
npm test             # template tests, incl. the quadlet fixture shared with wadd
npm run build        # dist/, which wadd serves
```

`npm run dev` needs `wadd` running for the machine pages; from
`Workspace-Switcher`, `dev/run-dev.sh` starts it. Run one or the other on
port 8081: stop `wadd`'s copy with `wadcreator.enabled: false` in
`dev/workspaces.dev.yaml` while using the Vite dev server.

## Build folder

`src/templates/index.ts` generates the same layout as the hand-written
`WadSpaces/containers/<id>/` directories:

```
Dockerfile  docker-compose.yml  README.md  wad-<id>.container  workspaces.yaml.snippet
root/etc/wadspaces/repos.list
root/etc/wadspaces/kalebrowser-resources.json
root/usr/share/backgrounds/wallpaper.<ext>
```

Tests check the generated files against `../containers` and check that the
quadlet renderer matches `wadd`'s byte for byte, using a fixture shared with
`Workspace-Switcher/tests/fixtures/`. The six existing workspaces are in
`src/lib/presets.ts`, so editing them shows their build settings.

## Deploy (hosted, later)

```bash
npm run build
firebase deploy --only hosting,firestore,storage
firebase deploy --only functions   # asks for WEB_API_KEY
```

Grant the Functions service account "Service Account Token Creator", or
`enrollMachine` fails on `iam.serviceAccounts.signBlob`.
