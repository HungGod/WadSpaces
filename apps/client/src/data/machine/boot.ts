// Every boot starts at sign-in. Firebase would restore the last sign-in from
// the webview's storage, and checks it online first, which stalls the start
// for minutes while the network comes up. So on the first start after a boot,
// before Firebase loads (firebase.ts), its saved sign-in is deleted. Starts
// later in the same boot (the app restarting) keep it.
import { commands } from "@/gen/bindings";

const BOOT_KEY = "wadspaces.signInBoot";
/** Where firebase.ts's persistences keep the user. */
const AUTH_DB = "firebaseLocalStorageDb";
const AUTH_KEY = "firebase:authUser:";

function deleteDb(name: string) {
  return new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error(`${name} is open`));
  });
}

export async function forgetSignInAfterReboot() {
  try {
    const boot = await commands.bootId();
    if (!boot || localStorage.getItem(BOOT_KEY) === boot) return;
    await deleteDb(AUTH_DB);
    for (const k of Object.keys(localStorage)) if (k.startsWith(AUTH_KEY)) localStorage.removeItem(k);
    localStorage.setItem(BOOT_KEY, boot);
  } catch (e) {
    console.warn("Couldn't forget the last sign-in:", e);
  }
}
