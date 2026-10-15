#!/usr/bin/env bash
# The native client's account (crates/wad-account) against the Firebase
# emulators, with the real firestore.rules: sign-in, usernames, linking
# codes, the GitHub token, a restart. Nothing touches the real project.
#
#   apps/client/dev/try-account.sh
#
# Needs Java (the Firestore emulator) and the web app's repo beside this one
# (WADSPACES_CLIENT_DIR, default ../wadspaces-client) with its npm packages:
# its firebase.json and firestore.rules.
set -euo pipefail
root=$(cd "$(dirname "$0")/../../.." && pwd)
web=$(cd "${WADSPACES_CLIENT_DIR:-$root/../wadspaces-client}" && pwd)
(cd "$root" && cargo build -q -p wad-account --example emulator)
cd "$web"
npx firebase emulators:exec --project demo-client --only auth,firestore "$root/target/debug/examples/emulator" 2>&1 \
  | grep -vE "^i  |^⚠  |^✔  |^\s*$|emulators:|Running script"
exit "${PIPESTATUS[0]}"
