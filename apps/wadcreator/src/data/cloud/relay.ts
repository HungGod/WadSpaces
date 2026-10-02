// Writing to the machines' cloud relay. wadd/cloud.py on each machine writes a
// heartbeat to users/{uid}/machines/{mid} every 30 s and runs the commands
// queued under it; CloudBackend listens to the heartbeats. See firestore.rules
// for what each side may write.
import { addDoc, collection, doc, serverTimestamp, setDoc } from "firebase/firestore";
import { db } from "./firebase";
import { newEnrollCode } from "./relayCore";

export { ONLINE_WITHIN_MS, isOnlineNow, newEnrollCode, type RelayWorkspace } from "./relayCore";

export type CommandType = "switch" | "start" | "stop" | "restart" | "projects-sync" | "sync-secrets" | "launch";

/** Queue a command; the machine picks it up within a few seconds. */
export async function sendCommand(uid: string, mid: string, type: CommandType, wsId?: string): Promise<void> {
  await addDoc(collection(db, "users", uid, "machines", mid, "commands"), {
    type,
    ...(wsId && { wsId }),
    status: "pending",
    createdAt: serverTimestamp(),
  });
}

/** A one-time code for linking a machine; the enrollMachine function redeems
 *  it within 15 minutes. */
export async function createEnrollCode(uid: string, machineName: string): Promise<string> {
  const code = newEnrollCode();
  await setDoc(doc(db, "enrollCodes", code), { uid, used: false, machineName, createdAt: serverTimestamp() });
  return code;
}
