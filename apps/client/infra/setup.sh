#!/usr/bin/env bash
# One-time Google Cloud setup for the WadSpaces Client (apps/client). Safe to re-run: every step
# checks before it creates, and IAM bindings are idempotent.
#
# Do the console steps first (project, Blaze, Firestore, Auth — see
# infra/README.md), then run this in Cloud Shell as a project Owner:
#
#   git clone … && cd wadspaces/apps/client
#   PROJECT_ID=<your-project-id> ./infra/setup.sh
#
# The online side is Firebase only: Auth, Firestore, Hosting and the
# enrollMachine function (Cloud Functions 2nd gen, which deploys through Cloud
# Build and runs on Cloud Run). This enables those APIs and creates the
# functions' runtime account, `wad-functions`, with only the roles it needs.
# No service-account keys are ever made.
set -euo pipefail

: "${PROJECT_ID:?set PROJECT_ID, e.g. PROJECT_ID=wadcreator-1234 ./infra/setup.sh}"
REGION="${REGION:-australia-southeast2}"

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
quiet() { "$@" > /dev/null 2>&1; }

gcloud config set project "${PROJECT_ID}" > /dev/null
PN="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"
SA="wad-functions@${PROJECT_ID}.iam.gserviceaccount.com"

# --------------------------------------------------------------------- APIs
step "Enabling APIs (takes a minute the first time)"
gcloud services enable \
  firebase.googleapis.com firebasehosting.googleapis.com firebaserules.googleapis.com \
  firestore.googleapis.com identitytoolkit.googleapis.com securetoken.googleapis.com \
  cloudfunctions.googleapis.com run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com eventarc.googleapis.com pubsub.googleapis.com
gcloud services enable \
  secretmanager.googleapis.com compute.googleapis.com iam.googleapis.com \
  iamcredentials.googleapis.com logging.googleapis.com

# ----------------------------------------------------------- service account
step "Service account"
if quiet gcloud iam service-accounts describe "${SA}"; then
  echo "  wad-functions: exists"
else
  gcloud iam service-accounts create wad-functions --display-name "WadCreator Cloud Functions" > /dev/null
  echo "  wad-functions: created"
fi

# ---------------------------------------------------------------------- IAM
step "IAM bindings"
prole() { quiet gcloud projects add-iam-policy-binding "${PROJECT_ID}" --member="$1" --role="$2" --condition=None; }

FN="serviceAccount:${SA}"
for r in roles/datastore.user roles/firebaseauth.admin roles/logging.logWriter; do
  prole "${FN}" "$r"
done
# Custom tokens for machines are signed with signBlob, as itself.
quiet gcloud iam service-accounts add-iam-policy-binding "${SA}" --member="${FN}" --role=roles/iam.serviceAccountTokenCreator
echo "  wad-functions: done"

# Functions deploys build their containers as the default compute account.
COMPUTE="serviceAccount:${PN}-compute@developer.gserviceaccount.com"
prole "${COMPUTE}" roles/cloudbuild.builds.builder
prole "${COMPUTE}" roles/logging.logWriter
echo "  default compute account: done"

# ------------------------------------------------------------------ summary
step "Done. Values for apps/client/functions/.env.${PROJECT_ID}:"
cat <<EOF
WAD_REGION=${REGION}
WAD_FUNCTIONS_SA=${SA}
EOF
echo
echo "The web API key machines sign in with is the WEB_API_KEY secret:"
echo "  firebase functions:secrets:set WEB_API_KEY"
