# WadSpaces Client

Make and run wadspaces on your WadSpaces machines. A wadspace is built in
three layers: a **template** (the base image plus apps), a **customization**
of it (VS Code extensions, WadBrowser's web apps and mode, tools, what opens
at boot), each its own container image, and the **wadspace** itself (name,
background, project folders and saved sign-ins), which has no image: wadd
mounts those when it starts.

One React + Vite + TypeScript + Tailwind codebase, built three ways by
`VITE_TARGET`:

| | `offline` (default) | `online` | `machine` |
|---|---|---|---|
| Runs | in Tauri on a machine, no account (`npm run app:offline`) | in any browser, on Firebase Hosting | in Tauri on a WadSpaces machine, signed in (`npm run app`) |
| Documents | in wadd's library (`src/data/local`) | in Firestore (`src/data/cloud`) | in Firestore, installed here (`src/data/machine`) |
| Builds and launches | wadd on this machine | the default machine, through its cloud relay | wadd on this machine |
| Account | none: "you" are the machine | GitHub | GitHub |

Pages and components only talk to the backend interface in
`src/data/backend.ts`; each target implements it, and `backend.caps` hides
what one can't do. In a plain browser the offline target can't reach wadd
(it listens on a Unix socket the Tauri shell bridges), so there it's the UI
alone.

## Layout

```
src/core/              shared with wad-core (crates/wad-core, as WebAssembly in src/gen/wasm)
  layers.ts            templates, customizations, wadspaces: setups, slots, desktops, Dockerfiles
  catalog/catalog.ts   the Builder's catalog (crates/wad-core/data/catalog.json) and starters
  generator/           the Dockerfile, root/ overlay and quadlet wadd writes, byte for byte
src/data/              backend.ts, layers.ts (shared by the backends), migrate.ts,
                       local/ (wadd), cloud/ (Firebase, the relay), machine/ (both)
src/pages/             Home, Builder, Projects, Secrets, Machines, Login/Welcome
src/components/        Shell, the launcher and the Builder's steps (wadbuilder/), the
                       desktop as the image draws it (desktop/), the details drawer
src/test/              a fake backend and the sample library the app's tests use
functions/             Cloud Functions
infra/                 Google Cloud setup (see infra/README.md)
```

## Develop

```bash
npm install
npm run app:offline            # the offline app in Tauri, against wadd on this machine
npm run app                    # the machine app (needs .env.local)
VITE_TARGET=online npm run dev # the web app on http://localhost:8081 (needs .env.local)
npm test                       # unit tests, and the app's tests (jsdom, a fake backend)
npm run test:rules             # firestore.rules against the emulator
```

The offline and machine apps need wadd: `cargo run -p wadd -- serve --user`
from the monorepo's root, or a WadSpaces machine's own.

For the online and machine apps copy `.env.example` to `.env.local`
(Firebase console → Project settings → Web app). Set `VITE_USE_EMULATORS=1`
to use `firebase emulators:start` instead of the real project.

After changing wad-core run `cargo xtask wasm` (and `cargo xtask bindings`
after wad-proto or Tauri command changes); `cargo xtask ci` checks it all.

## The Builder

1. **Choose your template.** One stack per template: the template, its
   customizations, then the wadspaces built from them. A stack's picker
   starts from any of them, opens (launches) a wadspace, edits one, or starts
   a new one from it. A new library starts with the Writing and Dev starter
   templates (`crates/wad-core/data/starters.json`), made once as your own.
   Recently deleted, at the bottom, restores or deletes for good.
2. **Template customization.** Changes are saved under a new name as a
   customization, and saving builds its image (its template's first when that
   isn't built). Import brings in parts of another customization.
3. **WadSpaces construction.** Name, background, project folders, and a
   secret per app that keeps a sign-in (each web app, AI extensions, Obsidian,
   Steam): a new saved sign-in, an existing one of the same kind (several
   slots can share one), or none.

The preview beside Steps 2 and 3 is the desktop the image draws (selkies
-desktop's grid and panel, the WadSpaces logo on the Start button and in the
middle) at the machine's screen size; its Image tab shows each layer's
Dockerfile and how its image stands: not built, building, built, or changed
since built.

The sidebar's **Launch** starts wadspaces, WadBrowser, WadBrowser Focus,
saved WadBrowser setups and the terminal together, or as a focus session. A
wadspace can be customized for one run (its background, folders and
sign-ins), saved as a new one, or run once and thrown away; a WadBrowser can
be set up with web apps and sign-ins and saved to launch again.

## From layers to images

A layer's build folder comes from wad-core (`templateLayer`,
`customizationLayer`): a template is `FROM localhost/wadspaces-base:trixie`
with a `RUN` per app (`wadspaces-feature`, or Debian packages through
`wadspaces-apt`); a customization is `FROM` its template's image with tools,
VS Code extensions (installed at build time, seeded into the home folder at
start) and web apps (`wadspaces-webapp`), and both carry
`/etc/wadspaces/layout.json` and WadBrowser's config. wadd builds them
(`POST /v1/images/build`) and labels each image with its folder's sha and
the image it was built on, which is how a changed layer is told apart.

Installing a wadspace (`PUT /v1/wadspaces/{id}`) gives wadd its layers; the
app draws its wallpaper and uploads it, and wadd mounts that, its project
folders (`~/Desktop/<folder>`) and its saved sign-ins
(`/var/lib/wadspaces-signins/<id>`) when it starts. Nothing about a
wadspace's own things is in an image, so changing them needs no build.

A library from before the layers moves onto them on the first load
(`src/data/migrate.ts`): each old wadspace becomes a template, a
customization when it has more, and a wadspace with the same id that runs
its old image until its layers are built.

## Online: the web app

It's at https://wad-spaces.web.app.

```bash
npm run build:online
firebase deploy --only hosting,firestore:rules,firestore:indexes
firebase deploy --only functions      # enrollMachine; its key is the WEB_API_KEY secret
```

Documents: `users/{uid}/templates`, `users/{uid}/customizations` and
`users/{uid}/browsers`, wadspaces at `wadspaces/{id}` (with `owner`), and
`profiles/{uid}.startersCreated`. The default machine's layer images, saved
sign-in names and screen size come in its heartbeat; builds, installs and
launches are relay commands (`build`, `install`, `launch-run`), which wadd
(`../wadd/src/cloud.rs`) runs.

The Google Cloud side is Firebase only (Auth, Firestore, Hosting and the
`enrollMachine` function): `infra/setup.sh` enables the APIs and makes the
functions' service account; see `infra/README.md`.

Sign-in is GitHub only (Firebase's GitHub provider, with the OAuth App in
`host/usr/lib/wadspaces/github.toml`). The web app uses Firebase's popup. The
machine app opens `/machine-signin.html` from Hosting in a window of its own
(`src/signin`, `src-tauri/src/github.rs`): the GitHub token it hands back signs
the app in and becomes the machine's `github_token`. So Hosting has to be
deployed before a machine can sign in.

A machine links to your account in the machine app's first-run setup
(`src/components/machine/MachineGate.tsx`, with a one-time enrollment
code); the offline app links with a code on **Machines → Link to your
account**. wadd then heartbeats every 30 s and runs the commands the web app
queues.
