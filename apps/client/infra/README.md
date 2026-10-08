# Google Cloud setup

The WadSpaces Client's online side runs on one Google Cloud / Firebase project in
**australia-southeast2**, and only on Firebase: Auth, Firestore, Hosting and
one Cloud Function (`enrollMachine`). Images are built and run on your own
machines, so there are no buckets, registries or build pipelines of ours.
Setup is two parts: a few console clicks, then `setup.sh` in Cloud Shell.

## 1. Console (once)

1. **Create the project**: console.firebase.google.com → Add project. The ID
   must be globally unique (e.g. `wadcreator-<suffix>`). Analytics: off.
   The Google account running the Firebase CLI on the dev laptop needs
   **Owner** (IAM → Grant access) if it isn't the one creating the project.
2. **Blaze plan**: link a billing account. Then Billing → Budgets & alerts →
   e.g. A$25/month with alerts at 50 / 90 / 100 %. A budget alerts; it
   doesn't cap.
3. **Firestore**: Create database → Native mode → **australia-southeast2** →
   production rules. (Location is permanent.)
4. **Authentication**: Get started → Sign-in method → enable
   **Email/Password** (not email link) and **Google** (public name
   "WadCreator", support email). Authorized domains: keep `localhost`,
   `<project>.web.app`, `<project>.firebaseapp.com`.
5. **Google Auth Platform** (console.cloud.google.com/auth): Branding (app
   name, support email, developer contact; no logo — a logo needs
   verification) → Audience: External → **Publish app**.
6. **Register a Web app**: Project settings → Your apps → Web ("WadCreator
   Web", tick "Also set up Firebase Hosting"). Copy the config values into
   `apps/client/.env.local` (see `.env.example`).

## 2. Cloud Shell (once, re-runnable)

Open Cloud Shell in the project, get this repo there, and run:

```sh
PROJECT_ID=<your-project-id> ./infra/setup.sh
```

It enables the Firebase APIs plus the ones Cloud Functions 2nd gen runs on
(Cloud Run, Cloud Build, Artifact Registry, Eventarc, Pub/Sub, Secret
Manager), creates the `wad-functions` service account (no keys) with
Firestore, Firebase Auth admin, log writing, and Token Creator on itself (to
sign machines' custom tokens), and lets the default compute account run the
functions' deploy builds. It prints `WAD_REGION` and `WAD_FUNCTIONS_SA` for
`functions/.env.<project-id>` at the end.

Firebase manages what Functions creates behind the scenes (`gcf-artifacts`,
the `gcf-*` buckets, the function's Cloud Run service); leave those alone.

## 3. Dev laptop

```sh
# gcloud without sudo
curl -fsSLO https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-linux-x86_64.tar.gz
tar -xzf google-cloud-cli-linux-x86_64.tar.gz -C ~ && ~/google-cloud-sdk/install.sh --quiet --path-update=true
gcloud auth login && gcloud auth application-default login
gcloud config set project <project-id>

# Firebase CLI as a project Owner
firebase login:add        # if the owner isn't the current account
firebase use --add <project-id>
```

## 4. Removing the old cloud-build resources (once)

An earlier version also made build buckets, Artifact Registry repos, a
release bucket for over-the-air updates, a Storage bucket for cloud files, and
four more service accounts. `teardown.sh` removes exactly those, by name:

```sh
./infra/teardown.sh                        # dry run: backs nothing up, deletes nothing
./infra/teardown.sh --apply                # backs up to infra/backup/<date>/, then deletes
```

The dry run prints every command and lists what else is in the project
(functions, Cloud Run services, triggers) for a look, without touching it.
