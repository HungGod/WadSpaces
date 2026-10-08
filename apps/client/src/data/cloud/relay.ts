// Writing to the machines' cloud relay. wadd/cloud.py on each machine writes a
// heartbeat to users/{uid}/machines/{mid} every 30 s and runs the commands
// queued under it; CloudBackend listens to the heartbeats. See firestore.rules
// for what each side may write.
import { addDoc, collection, doc, onSnapshot, serverTimestamp, setDoc } from "firebase/firestore";
import { db } from "./firebase";
import { newEnrollCode } from "./relayCore";

export { ONLINE_WITHIN_MS, isOnlineNow, newEnrollCode, type RelayWorkspace } from "./relayCore";

export type CommandType = "switch" | "start" | "stop" | "restart" | "projects-sync" | "sync-secrets" | "launch";

/** Queue a command; the machine picks it up within a few seconds. Its id. */
export async function sendCommand(
  uid: string,
  mid: string,
  type: CommandType,
  wsId?: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const ref = await addDoc(collection(db, "users", uid, "machines", mid, "commands"), {
    ...extra,
    type,
    ...(wsId && { wsId }),
    status: "pending",
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

/** How a command went: its result once the machine has run it (a failure's
 *  message thrown), or a timeout. */
export function commandResult(uid: string, mid: string, id: string, timeoutMs = 60_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stop();
      reject(new Error("The machine didn't answer. Is it on?"));
    }, timeoutMs);
    const stop = onSnapshot(doc(db, "users", uid, "machines", mid, "commands", id), (snap) => {
      const d = snap.data();
      if (!d || (d.status !== "done" && d.status !== "error")) return;
      clearTimeout(timer);
      stop();
      const result = (d.result ?? {}) as Record<string, unknown>;
      if (d.status === "error") reject(new Error(String(result.error ?? "It didn't work.")));
      else resolve(result);
    });
  });
}

/** A one-time code for linking a machine; the enrollMachine function redeems
 *  it within 15 minutes. */
export async function createEnrollCode(uid: string, machineName: string): Promise<string> {
  const code = newEnrollCode();
  await setDoc(doc(db, "enrollCodes", code), { uid, used: false, machineName, createdAt: serverTimestamp() });
  return code;
}
