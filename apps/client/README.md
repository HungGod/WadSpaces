# WadSpaces Client

Make and run wadspaces on your WadSpaces machines. A wadspace is a stack of
layers: **templates** (the base image plus apps; one can build on another
whose apps it all has), maybe **Extensions** (VS Code extensions, WadBrowser's
web apps and mode, tools, what opens at boot), each its own container image,
and its **Customization** (name, background, projects and keys), which has no
image: wadd hands it over when the wadspace starts. Projects aren't mounted:
the wadspace clones its GitHub repositories and copies in files from the
machine itself.

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
  layers.ts            templates (and their chains), Extensions, wadspaces (stacks): setups, keys, desktops, Dockerfiles
  catalog/catalog.ts   the Builder's catalog (crates/wad-core/data/catalog.json) and starters
  generator/           the Dockerfile, root/ overlay and quadlet wadd writes, byte for byte
src/data/              backend.ts, layers.ts (shared by the backends), migrate.ts,
                       local/ (wadd), cloud/ (Firebase, the relay), machine/ (both)
src/pages/             Home, Builder, Secrets, Machines, Login/Welcome
src/components/        Shell, the Builder's board (builder/: the board, its editors, and
                       sync.ts between it and the documents), the launcher (launcher/),
                       the desktop as the image draws it (desktop/), the details drawer
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
npm run dev:fake               # the UI on the tests' fake backend and sample library (?empty: none)
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

A board: every wadspace is a stack of modules in one row, stepped through
with the arrows. Templates are ice blue, Extensions acid green,
Customizations pink; each is drawn as a small desktop.

- **Drag** a module (and what's on top of it) onto a stack to copy it there,
  **Shift**+drag to take just one; right-click mid-drag cancels. A drop never
  refuses: what it replaces goes to Recently deleted, and a stack that no
  longer adds up (setups or keys for an app its template hasn't) says so,
  with a Fix. Hold a drag between two stacks (or drop it after the last) for
  a new stack. **+ Create** puts a stack with a blank template at the end.
- **Click** a module to edit it: a template's apps (drop them anywhere on its
  desktop), Extensions' setups, a Customization's look, projects (GitHub
  repositories to clone; folders or files on the machine to copy in) and
  keys (one per app that signs in; WadBrowser's apps share keys in groups).
  Click a name to rename it.
- **Ctrl+click** selects; Delete (or the Delete bucket) deletes, asking first
  for a whole stack. **Build all** builds every stack that needs it, or drop
  one stack on it. Undo undoes.

What's on the board is the documents (`components/builder/sync.ts`): a
template or Extensions layer is shared by the stacks that have it while
they're the same, and copied for the one that changes it. A new library
starts with the Writing and Dev starter templates
(`crates/wad-core/data/starters.json`), made once as your own.

The sidebar's **Launch** starts wadspaces, WadBrowser, WadBrowser Focus,
saved WadBrowser setups and the terminal together, or as a focus session. A
wadspace can be customized for one run (its background and keys), saved as a
new one, or run once and thrown away; a WadBrowser can be set up with web
apps and sign-ins and saved to launch again.

## From layers to images

A layer's build folder comes from wad-core (`templateLayer`,
`extensionsLayer`): a template is `FROM localhost/wadspaces-base:trixie`, or
`FROM` the template it builds on, with a `RUN` per app it adds
(`wadspaces-feature`, or Debian packages through `wadspaces-apt`); an
Extensions layer is `FROM` its template's image with tools, VS Code
extensions (installed at build time, seeded into the home folder at start)
and web apps (`wadspaces-webapp`), and each carries
`/etc/wadspaces/layout.json` and WadBrowser's config. wadd builds them
(`POST /v1/images/build`, with what a template builds on) and labels each
image with its folder's sha and the image it was built on, which is how a
changed layer, or one on a rebuilt one, is told apart.

Installing a stack (`PUT /v1/wadspaces/{id}`, when it's built or launched)
gives wadd its layers; the app draws its wallpaper and uploads it. When it
starts, wadd hands over the wallpaper, its saved sign-ins
(`/var/lib/wadspaces-signins/<id>`) and its projects' list; the wadspace
clones its GitHub repositories into `~/Desktop/<folder>` in the background
(and fast-forwards them at each start when that's safe), and copies in what
wadd copied from the machine (`POST /v1/copies`). Nothing about a wadspace's
own things is in an image, so changing them needs no build.

A library from before stacks moves onto them on the first load
(`src/data/migrate.ts`, with wad-core's `migrateV2`): Extensions layers to
their own collection, each wadspace to a stack, folder and drive projects to
copies made at their first start.

## Online: the web app

It's at https://wad-spaces.web.app.

```bash
npm run build:online
firebase deploy --only hosting,firestore:rules,firestore:indexes
firebase deploy --only functions      # enrollMachine; its key is the WEB_API_KEY secret
```

Documents: `users/{uid}/templates`, `users/{uid}/extensions` and
`users/{uid}/browsers`, wadspaces (stacks) at `wadspaces/{id}` (with `owner`), and
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
