# Wad Creator

Design, build and run WadSpaces wadspaces: a desktop of apps and a wallpaper
that becomes a container image, run on your WadSpaces machines.

One React + Vite + TypeScript + Tailwind codebase, built two ways by
`VITE_TARGET` (`src/lib/target.ts`):

| | Offline (desktop app) | Online (web app) |
|---|---|---|
| Runs | on a WadSpaces machine, as a window of its own (Electron, `desktop/`) | in any browser, on Firebase Hosting |
| Talks to | `wadd` on `http://127.0.0.1:8080` (`src/data/local`) | Firebase and your machines' cloud relay (`src/data/cloud`) |
| Account | none: "you" are the machine | email/password or Google, plus a username |
| Builds | on the machine with podman | not yet: build in the desktop app on the machine |
| Updates | with the host image (the USB stick) | redeploy Hosting |

Pages and components only talk to the backend interface in
`src/data/backend.ts`; each target implements it. Capability flags
(`backend.caps`) hide what a target can't do yet: sharing, projects, running
on another machine, AI agents and Quick Launch are "coming soon".

## Layout

```
src/core/          shared with Cloud Functions: no React, DOM or import.meta.env
  model.ts         the wadspace the Builder edits (layout, advanced, agent)
  catalog/         79 apps and how each installs (recipes.ts), bundled icons
  build.ts         wadspace → generator spec: install recipes, desktop order
  generator/       Dockerfile, root/ overlay, compose, quadlet (= wadd's, byte for byte)
  presets.ts       the six hand-written workspaces in ../Wadspaces-David
src/data/          backend.ts + local/ (wadd) + cloud/ (Firebase, relay)
src/pages/         Home, Wadspaces, Launch, Manager, Login/Signup/Welcome
src/components/    Shell, Builder, the desktop editor, cards, dialogs
desktop/           the Electron shell
functions/         Cloud Functions
infra/             Google Cloud setup (see infra/README.md)
```

## Develop

```bash
npm install
npm run dev                    # offline UI on http://localhost:8081 (needs wadd)
VITE_TARGET=online npm run dev # online UI (needs .env.local)
npm test                       # unit tests
npm run test:rules             # firestore.rules against the emulator
```

The offline UI needs `wadd`. From `../Wadspaces-Tools`:

```bash
PYTHONPATH=. .venv/bin/python -m wadd --config dev/workspaces.dev.yaml serve --dev --no-cdp --no-hotkeys
```

For the online UI copy `.env.example` to `.env.local` (Firebase console →
Project settings → Web app). Set `VITE_USE_EMULATORS=1` to use
`firebase emulators:start` instead of the real project.

`REQUIRE_SIBLINGS=1 npm test` fails, rather than skips, when
`../Wadspaces-David` or `../Wadspaces-Tools` is missing: the generator tests
compare against the real Dockerfiles and wadd's quadlet fixtures.

## Offline: the desktop app

On a machine, Home's **Wad Creator** link asks wadd to start it
(`POST /api/apps/wadcreator/open`); wadd runs `/usr/lib/wadcreator/wadcreator`
in the kiosk's sway session. The UI is served from `app://wadcreator/`, an
Origin wadd trusts.

```bash
npm run desktop          # build the offline UI and open it in Electron
npm run build:desktop    # desktop/out/linux-unpacked/, which host/build.sh puts in the image
```

Run these from a normal terminal: VS Code sets `ELECTRON_RUN_AS_NODE`.

The UI is baked into the app, which ships in the host image: a new Wad
Creator reaches a machine with a stick update (`host/build.sh update` in
`../Wadspaces-Tools`).

## Online: the web app

It's at https://wad-spaces.web.app.

```bash
npm run build:online
firebase deploy --only hosting,firestore:rules,firestore:indexes
firebase deploy --only functions      # enrollMachine; its key is the WEB_API_KEY secret
```

The Google Cloud side is Firebase only (Auth, Firestore, Hosting and the
`enrollMachine` function): `infra/setup.sh` enables the APIs and makes the
functions' service account; see `infra/README.md`. Uploaded wallpapers and
icons are downscaled in the browser and kept in the wadspace doc as data URLs
(at most 400 KB each), so there's no Storage bucket.

Machines link to an account with a one-time code: **Manager → Add machine**
online, then **Manager → Link to your account** in the machine's desktop app.
wadd (`../Wadspaces-Tools/wadd/cloud.py`) then heartbeats every 30 s and runs
the commands the web app queues (`switch`, `start`, `stop`, `restart`).

## From desktop to image

Each desktop icon installs the way its catalog recipe says
(`src/core/catalog/recipes.ts`): an existing `wadspaces-feature`, Debian
packages (`wadspaces-apt`), a Chrome web app (`wadspaces-webapp`), or "coming
soon". The icons' order and labels go into `/etc/wadspaces/layout.json`. The
Builder's Dockerfile view shows the result and downloads the build folder:

```
Dockerfile  docker-compose.yml  README.md  wad-<id>.container  workspaces.yaml.snippet
root/etc/wadspaces/{layout.json,kalebrowser-resources.json}
root/usr/share/backgrounds/wallpaper.{png,jpg}
```

Project files are never in it. Projects (the Projects page, and the Builder's
Projects step for a wadspace's defaults) are GitHub repositories (cloned onto
each machine with its `github_token` secret), folders on one machine, or
drives, which wadd mounts at `~/Desktop/<folder>` when it launches the
wadspace (`/api/launches`); the bundle's README names the defaults and its
compose file lists them as mounts to fill in by hand.

Build it with `../Wadspaces-David/build.sh --only <id>` after copying it
there. Desktops with Debian-package or web apps need the base image's
`wadspaces-apt`, `wadspaces-webapp --id` and `wadspaces-layout` helpers, which
arrive with in-app builds on the machine.
