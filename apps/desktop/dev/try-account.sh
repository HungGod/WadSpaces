#!/usr/bin/env bash
# The native client's account (crates/wad-account) against the Firebase
# emulators, with the real firestore.rules: sign-in, usernames, linking
# codes, the GitHub token, a restart. Nothing touches the real project.
#
#   apps/desktop/dev/try-account.sh
#
# Needs Java (the Firestore emulator) and apps/client's npm packages.
set -euo pipefail
root=$(cd "$(dirname "$0")/../../.." && pwd)
(cd "$root" && cargo build -q -p wad-account --example emulator)
cd "$root/apps/client"
npx firebase emulators:exec --project demo-client --only auth,firestore "$root/target/debug/examples/emulator" 2>&1 \
  | grep -vE "^i  |^⚠  |^✔  |^\s*$|emulators:|Running script"
exit "${PIPESTATUS[0]}"
