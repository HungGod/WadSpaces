#!/usr/bin/env bash
# Remove the Google Cloud resources the old cloud-build setup made: build and
# release buckets, the cloud-files Storage bucket, Artifact Registry repos,
# the build-status topic, the stream secret, and the service accounts that
# went with them. What Firebase needs (Auth, Firestore, Hosting,
# enrollMachine and what Functions makes behind the scenes) stays.
#
#   ./infra/teardown.sh            dry run: prints every command, runs only
#                                  read-only listings, deletes nothing
#   ./infra/teardown.sh --apply    backs up to infra/backup/<date>/, then deletes
#
# Every target is named below; nothing is matched by wildcard. Run
# `node scripts/migrate-assets.mjs --apply` first: wallpapers and icons that
# still point at the Storage bucket break once it's gone.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-wad-spaces}"
REGION="${REGION:-australia-southeast2}"
APPLY=""
case "${1:-}" in
  --apply) APPLY=1 ;;
  "") ;;
  *) echo "usage: $0 [--apply]" >&2; exit 2 ;;
esac

HERE="$(cd "$(dirname "$0")" && pwd)"
BACKUP="${HERE}/backup/$(date +%Y-%m-%d)"
SA() { echo "$1@${PROJECT_ID}.iam.gserviceaccount.com"; }
P=(--project="${PROJECT_ID}")

# ------------------------------------------------------------------ targets
BUCKETS=("${PROJECT_ID}-build-contexts" "${PROJECT_ID}-build-logs" "${PROJECT_ID}-releases")
FILES_BUCKET="wadspaces-wad-bucket"   # Firebase Storage (cloud files, uploaded images)
AR_REPOS=(wadspaces wadspaces-public)
TOPIC="cloud-builds"
SECRET="stream-ticket-key"
CUSTOM_ROLE="wadPublicObjectReader"
OLD_SAS=(wad-builder wad-base-builder wad-puller wad-gateway)
FN="serviceAccount:$(SA wad-functions)"
FN_EXTRA_ROLES=(roles/cloudbuild.builds.editor roles/eventarc.eventReceiver roles/run.invoker)

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { echo "teardown: $*" >&2; exit 1; }

FAILED=()
# Print a delete; with --apply, run it. Already gone counts as done.
gone() {
  printf '  $ %s\n' "$*"
  [[ -n "${APPLY}" ]] || return 0
  local out
  if out="$("$@" 2>&1)"; then
    return 0
  elif grep -qiE 'not ?found|does not exist|already deleted|404' <<< "${out}"; then
    echo "    (already gone)"
  else
    echo "${out}" | sed 's/^/    /' >&2
    FAILED+=("$*")
  fi
}

# The topic's subscriptions go with it (read-only lookup).
mapfile -t SUBS < <(gcloud pubsub topics list-subscriptions "${TOPIC}" "${P[@]}" --format='value(.)' 2> /dev/null || true)

# ------------------------------------------------------- keep-list guard
# Firebase's own resources must never be on the delete list.
step "Checking the delete list against what must stay"
for t in "${BUCKETS[@]}" "${FILES_BUCKET}" "${AR_REPOS[@]}" "${TOPIC}" "${SUBS[@]##*/}" "${SECRET}" "${CUSTOM_ROLE}" "${OLD_SAS[@]}"; do
  case "${t}" in
    gcf-*|gcf-artifacts|WEB_API_KEY|*appspot*) die "refusing: ${t} matches the keep list (Firebase's own; delete what uses it by hand first)" ;;
  esac
done
echo "  ok"
echo "  project ${PROJECT_ID}, region ${REGION}, $([[ -n "${APPLY}" ]] && echo "APPLYING" || echo "dry run")"

# ------------------------------------------------------------ 1. export
step "1. Back up the cloud files"
FILES_URL="https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/files"
if [[ -z "${APPLY}" ]]; then
  echo "  $ mkdir -p ${BACKUP}"
  echo "  $ gcloud storage ls -r -l gs://${FILES_BUCKET} > ${BACKUP}/${FILES_BUCKET}.list"
  echo "  $ gcloud storage cp -r gs://${FILES_BUCKET} ${BACKUP}/"
  echo "  $ curl -H 'Authorization: Bearer <gcloud auth print-access-token>' '${FILES_URL}?pageSize=300' > ${BACKUP}/files-0.json  (and further pages)"
else
  mkdir -p "${BACKUP}"
  if gcloud storage buckets describe "gs://${FILES_BUCKET}" "${P[@]}" > /dev/null 2>&1; then
    gcloud storage ls -r -l "gs://${FILES_BUCKET}" "${P[@]}" > "${BACKUP}/${FILES_BUCKET}.list" || die "couldn't list gs://${FILES_BUCKET}"
    # `cp -r` of an empty bucket fails ("matched no objects"), so only copy
    # when there is something in it.
    if gcloud storage ls "gs://${FILES_BUCKET}/**" "${P[@]}" > /dev/null 2>&1; then
      gcloud storage cp -r "gs://${FILES_BUCKET}" "${BACKUP}/" "${P[@]}" || die "couldn't copy gs://${FILES_BUCKET}"
      echo "  gs://${FILES_BUCKET} → ${BACKUP}/${FILES_BUCKET}"
    else
      echo "  gs://${FILES_BUCKET} is empty, nothing to copy"
    fi
  else
    echo "  gs://${FILES_BUCKET}: not there, nothing to copy"
  fi
  TOKEN="$(gcloud auth print-access-token)" || die "no access token (gcloud auth login)"
  page=""
  n=0
  while :; do
    out="${BACKUP}/files-${n}.json"
    curl -fsSg --get -H "Authorization: Bearer ${TOKEN}" --data-urlencode "pageSize=300" \
      ${page:+--data-urlencode "pageToken=${page}"} "${FILES_URL}" > "${out}" || die "couldn't read the files collection"
    page="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1])).get("nextPageToken", ""))' "${out}")" || die "bad page ${out}"
    [[ -n "${page}" ]] || break
    n=$((n + 1))
  done
  echo "  Firestore files/ → ${BACKUP}/files-*.json"
fi
echo "  Reminder: node scripts/migrate-assets.mjs --apply, before the Storage bucket goes."

# --------------------------------------------------------- 2. inventory
# Read-only, in both modes: what else is in the project, for a look. Nothing
# here is deleted.
step "2. What else is there (not touched)"
# inventory TITLE KEEP COMMAND...: KEEP is an awk condition on the listed fields.
inventory() {
  local what="$1" keep="$2"
  shift 2
  echo "  ${what}:"
  local out
  if ! out="$("$@" "${P[@]}" 2> /dev/null)"; then
    echo "    (couldn't list: API off or no access)"
  elif [[ -z "${out}" ]]; then
    echo "    (none)"
  else
    awk -F'\t' "{ print ((${keep}) ? \"    keep  \" : \"    LOOK  \") \$1 }" <<< "${out}"
  fi
}
inventory "Cloud Functions (only enrollMachine is ours)" '$1 == "enrollMachine"' \
  gcloud functions list --format='value(name.basename())'
inventory "Cloud Run services (Functions' own are labelled goog-managed-by=cloudfunctions)" '$2 ~ /goog-managed-by=cloudfunctions/' \
  gcloud run services list --format='value(metadata.name,metadata.labels)'
inventory "Cloud Scheduler jobs" 0 gcloud scheduler jobs list --location="${REGION}" --format='value(name.basename())'
inventory "Eventarc triggers" 0 gcloud eventarc triggers list --location=- --format='value(name.basename())'
inventory "Cloud Build triggers (global)" 0 gcloud builds triggers list --format='value(name)'
inventory "Cloud Build triggers (${REGION})" 0 gcloud builds triggers list --region="${REGION}" --format='value(name)'
inventory "Buckets (step 3 deletes the old ones by name)" '$1 ~ /^gcf-|appspot/' gcloud storage buckets list --format='value(name)'

# ----------------------------------------------------------- 3. deletes
if [[ -n "${APPLY}" && -t 0 ]]; then
  echo
  read -r -p "Delete what the dry run lists from ${PROJECT_ID}? This can't be undone. Type the project id: " answer
  [[ "${answer}" == "${PROJECT_ID}" ]] || die "not confirmed; nothing deleted"
fi

step "3a. Roles wad-functions no longer needs"
for r in "${FN_EXTRA_ROLES[@]}"; do
  gone gcloud projects remove-iam-policy-binding "${PROJECT_ID}" --member="${FN}" --role="${r}" --all --quiet
done
# Impersonation (pull tokens, builds), and access to what's deleted below.
gone gcloud iam service-accounts remove-iam-policy-binding "$(SA wad-puller)" --member="${FN}" --role=roles/iam.serviceAccountTokenCreator "${P[@]}" --quiet
gone gcloud iam service-accounts remove-iam-policy-binding "$(SA wad-builder)" --member="${FN}" --role=roles/iam.serviceAccountUser "${P[@]}" --quiet
gone gcloud storage buckets remove-iam-policy-binding "gs://${BUCKETS[0]}" --member="${FN}" --role=roles/storage.objectAdmin "${P[@]}"
gone gcloud storage buckets remove-iam-policy-binding "gs://${BUCKETS[1]}" --member="${FN}" --role=roles/storage.objectViewer "${P[@]}"
gone gcloud storage buckets remove-iam-policy-binding "gs://${FILES_BUCKET}" --member="${FN}" --role=roles/storage.objectAdmin "${P[@]}"
gone gcloud artifacts repositories remove-iam-policy-binding wadspaces --location="${REGION}" --member="${FN}" --role=roles/artifactregistry.repoAdmin "${P[@]}"
gone gcloud secrets remove-iam-policy-binding "${SECRET}" --member="${FN}" --role=roles/secretmanager.secretAccessor "${P[@]}"
# Storage rules read Firestore through this agent; no Storage, no rules.
PN="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)' 2> /dev/null || echo "<project-number>")"
gone gcloud projects remove-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:service-${PN}@gcp-sa-firebasestorage.iam.gserviceaccount.com" \
  --role=roles/firebaserules.firestoreServiceAgent --all --quiet

step "3b. Buckets"
for b in "${BUCKETS[@]}"; do
  gone gcloud storage rm -r "gs://${b}" "${P[@]}"
done
# Unlink from Firebase first, or Firebase keeps a dangling bucket reference.
UNLINK_URL="https://firebasestorage.googleapis.com/v1beta/projects/${PROJECT_ID}/buckets/${FILES_BUCKET}:removeFirebase"
echo "  \$ curl -X POST -H 'Authorization: Bearer <gcloud auth print-access-token>' ${UNLINK_URL}"
if [[ -n "${APPLY}" ]]; then
  if ! out="$(curl -sS -X POST -H "Authorization: Bearer $(gcloud auth print-access-token)" \
      -H "x-goog-user-project: ${PROJECT_ID}" -w '\n%{http_code}' "${UNLINK_URL}" 2>&1)"; then
    echo "${out}" | sed 's/^/    /' >&2
    FAILED+=("unlink ${FILES_BUCKET} from Firebase")
  elif [[ "$(tail -n1 <<< "${out}")" == 404 ]]; then
    echo "    (not linked)"
  elif [[ "$(tail -n1 <<< "${out}")" != 2* ]]; then
    echo "${out}" | sed 's/^/    /' >&2
    FAILED+=("unlink ${FILES_BUCKET} from Firebase")
  fi
fi
gone gcloud storage rm -r "gs://${FILES_BUCKET}" "${P[@]}"

step "3c. Artifact Registry"
for r in "${AR_REPOS[@]}"; do
  gone gcloud artifacts repositories delete "${r}" --location="${REGION}" "${P[@]}" --quiet
done

step "3d. Pub/Sub"
for s in "${SUBS[@]}"; do
  gone gcloud pubsub subscriptions delete "${s}" "${P[@]}" --quiet
done
gone gcloud pubsub topics delete "${TOPIC}" "${P[@]}" --quiet

step "3e. Secret and custom role"
gone gcloud secrets delete "${SECRET}" "${P[@]}" --quiet
gone gcloud iam roles delete "${CUSTOM_ROLE}" --project="${PROJECT_ID}" --quiet

step "3f. Old service accounts"
for a in "${OLD_SAS[@]}"; do
  m="serviceAccount:$(SA "${a}")"
  for r in $(gcloud projects get-iam-policy "${PROJECT_ID}" --flatten='bindings[].members' \
      --filter="bindings.members:${m}" --format='value(bindings.role)' 2> /dev/null | sort -u); do
    gone gcloud projects remove-iam-policy-binding "${PROJECT_ID}" --member="${m}" --role="${r}" --all --quiet
  done
  gone gcloud iam service-accounts delete "$(SA "${a}")" "${P[@]}" --quiet
done

# ------------------------------------------------------------- 4. kept
step "4. Kept"
cat <<EOF
  Firebase Auth, Firestore, Hosting, and the enrollMachine function
  What Functions makes for itself: gcf-artifacts, gcf-* buckets, *appspot* buckets,
    the function's Cloud Run service
  The WEB_API_KEY secret
  wad-functions: Datastore user, Firebase Auth admin, log writer, Token Creator on itself
  The default compute account's Cloud Build builder and log writer roles
  The Pub/Sub service agent's Token Creator role
  Every enabled API (Functions 2nd gen runs on Run, Cloud Build, Artifact Registry,
    Eventarc and Pub/Sub)
EOF

if ((${#FAILED[@]})); then
  echo
  echo "These failed:" >&2
  printf '  %s\n' "${FAILED[@]}" >&2
  exit 1
fi
[[ -n "${APPLY}" ]] || printf '\nDry run: nothing was changed. Run with --apply to do it.\n'
