// Hosted mode (later): links a WadSpaces machine to a Wad Creator account.
// While Wad Creator runs locally on each machine this function is unused.
//
// The owner creates enrollCodes/{code} from the Machines page; the machine
// calls this with the code (wadd enroll CODE) and gets a Firebase custom token
// scoped to itself. The Functions service account needs the "Service Account
// Token Creator" role, or createCustomToken fails with iam.serviceAccounts.signBlob.
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, Timestamp, getFirestore } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { defineString } from "firebase-functions/params";

initializeApp();
const WEB_API_KEY = defineString("WEB_API_KEY", { description: "Web API key handed to enrolled machines" });

export const enrollMachine = onCall({ region: "australia-southeast2" }, async (req) => {
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
  return { machineId, ownerUid: uid, customToken, projectId: process.env.GCLOUD_PROJECT, apiKey: WEB_API_KEY.value() };
});
