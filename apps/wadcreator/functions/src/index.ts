// Cloud Functions for Wad Creator (project and settings: .env.<project-id>).
//
// enrollMachine links a WadSpaces machine to an account. The owner creates
// enrollCodes/{code} (Manager → Add machine); the machine calls this with the
// code (Wad Creator on the machine, or `wadd enroll CODE`) and gets a Firebase
// custom token scoped to itself: {role: "machine", owner, machineId}. The
// runtime account (wad-functions) signs it (Service Account Token Creator on
// itself, infra/setup.sh). The web API key the machine needs to sign in comes
// from Secret Manager (WEB_API_KEY), so it isn't in the repo.
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, Timestamp, getFirestore } from "firebase-admin/firestore";
import { setGlobalOptions } from "firebase-functions/v2";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";

initializeApp();
setGlobalOptions({
  region: process.env.WAD_REGION || "australia-southeast2",
  ...(process.env.WAD_FUNCTIONS_SA && { serviceAccount: process.env.WAD_FUNCTIONS_SA }),
});

const WEB_API_KEY = defineSecret("WEB_API_KEY");

export const enrollMachine = onCall({ secrets: [WEB_API_KEY] }, async (req) => {
  const code = String(req.data?.code ?? "").trim().toUpperCase();
  const hostname = String(req.data?.hostname ?? "").slice(0, 100);
  const machineName = String(req.data?.machineName ?? hostname).slice(0, 100);
  if (!/^[A-Z0-9]{6,12}$/.test(code)) throw new HttpsError("invalid-argument", "Bad enrollment code.");

  const db = getFirestore();
  const codeRef = db.doc(`enrollCodes/${code}`);
  const { uid, machineId } = await db.runTransaction(async (tx) => {
    const snap = await tx.get(codeRef);
    const c = snap.data();
    if (!c) throw new HttpsError("not-found", "Unknown enrollment code.");
    if (c.used) throw new HttpsError("failed-precondition", "This code was already used.");
    const created = (c.createdAt as Timestamp | undefined)?.toMillis() ?? 0;
    if (Date.now() - created > 15 * 60 * 1000) throw new HttpsError("deadline-exceeded", "This code has expired.");
    const machineRef = db.collection(`users/${c.uid}/machines`).doc();
    tx.set(machineRef, {
      name: c.machineName || machineName,
      hostname,
      daemonVersion: String(req.data?.daemonVersion ?? ""),
      enrolledAt: FieldValue.serverTimestamp(),
      lastSeen: FieldValue.serverTimestamp(),
      workspaces: [],
    });
    tx.update(codeRef, { used: true, machineId: machineRef.id });
    return { uid: c.uid as string, machineId: machineRef.id };
  });

  const customToken = await getAuth().createCustomToken(`machine:${machineId}`, {
    role: "machine",
    owner: uid,
    machineId,
  });
  return {
    machineId,
    ownerUid: uid,
    customToken,
    projectId: process.env.GCLOUD_PROJECT,
    apiKey: WEB_API_KEY.value(),
  };
});
