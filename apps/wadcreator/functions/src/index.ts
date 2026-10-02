// Cloud Functions for Wad Creator (project and settings: .env.<project-id>).
//
// enrollMachine links a WadSpaces machine to an account. The owner creates
// enrollCodes/{code} (Manager → Add machine); the machine calls this with the
// code (Wad Creator on the machine, or `wadd enroll CODE`) and gets a Firebase
// custom token scoped to itself: {role: "machine", owner, machineId}.
//
// A machine that's linked already sends its current ID token
// (previousIdToken). Relinked to the same owner, it keeps its machine
// document (relink: "same"); linked to another owner, its old owner's
// document goes (relink: "new-owner"), so it doesn't linger offline in their
// list. Without one (or with one that doesn't verify) it's a new machine
// (relink: "new"). The
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

  const previous = await previousMachine(req.data?.previousIdToken);
  const db = getFirestore();
  const codeRef = db.doc(`enrollCodes/${code}`);
  const { uid, machineId, relink } = await db.runTransaction(async (tx) => {
    const snap = await tx.get(codeRef);
    const c = snap.data();
    if (!c) throw new HttpsError("not-found", "Unknown enrollment code.");
    if (c.used) throw new HttpsError("failed-precondition", "This code was already used.");
    const created = (c.createdAt as Timestamp | undefined)?.toMillis() ?? 0;
    if (Date.now() - created > 15 * 60 * 1000) throw new HttpsError("deadline-exceeded", "This code has expired.");
    const owner = c.uid as string;
    const same = previous && previous.owner === owner ? db.doc(`users/${owner}/machines/${previous.machineId}`) : null;
    const kept = same ? (await tx.get(same)).exists : false;
    const machineRef = kept && same ? same : db.collection(`users/${owner}/machines`).doc();
    const fields = { hostname, daemonVersion: String(req.data?.daemonVersion ?? ""), lastSeen: FieldValue.serverTimestamp() };
    if (kept) {
      tx.update(machineRef, fields);
    } else {
      tx.set(machineRef, { ...fields, name: c.machineName || machineName, enrolledAt: FieldValue.serverTimestamp(), workspaces: [] });
    }
    if (previous && previous.owner !== owner) tx.delete(db.doc(`users/${previous.owner}/machines/${previous.machineId}`));
    tx.update(codeRef, { used: true, machineId: machineRef.id });
    const relink = kept ? "same" : previous && previous.owner !== owner ? "new-owner" : "new";
    return { uid: owner, machineId: machineRef.id, relink };
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
    relink,
  };
});

/** Who a machine's ID token says it is; null if it doesn't verify (expired,
 * revoked, a person's, garbage). */
async function previousMachine(token: unknown): Promise<{ owner: string; machineId: string } | null> {
  if (typeof token !== "string" || !token) return null;
  try {
    const t = await getAuth().verifyIdToken(token);
    const owner = t.owner, machineId = t.machineId;
    if (t.role !== "machine" || typeof owner !== "string" || typeof machineId !== "string") return null;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(owner) || !/^[A-Za-z0-9_-]{1,128}$/.test(machineId)) return null;
    return { owner, machineId };
  } catch {
    return null;
  }
}
