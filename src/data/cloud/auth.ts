// Accounts for the online app: Firebase Auth (email/password or Google) plus
// a WadSpaces profile with a unique username. The username is claimed in one
// transaction — usernames/{name} and profiles/{uid} together — and
// firestore.rules make sure nobody can take someone else's.
import {
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  signOut as fbSignOut,
  type User,
} from "firebase/auth";
import { doc, getDoc, runTransaction, serverTimestamp } from "firebase/firestore";
import { auth, db } from "./firebase";

export const USERNAME_RE = /^[a-z0-9_.-]{3,24}$/;
const COLORS = ["#c6ff1f", "#ff3d81", "#7c4dff", "#1de9b6", "#ffb020", "#40c4ff"];

let ready: Promise<User | null> | null = null;

/** The signed-in Firebase user, once Auth has restored the session. */
export function currentAuthUser(): Promise<User | null> {
  ready ??= new Promise((resolve) => {
    const off = onAuthStateChanged(auth, (u) => {
      off();
      resolve(u);
    });
  });
  return ready.then(() => auth.currentUser);
}

export function onAuthUser(fn: (u: User | null) => void) {
  return onAuthStateChanged(auth, fn);
}

function friendly(e: unknown): Error {
  const code = (e as { code?: string }).code ?? "";
  const msg: Record<string, string> = {
    "auth/invalid-credential": "Wrong email or password.",
    "auth/invalid-email": "That doesn't look like an email address.",
    "auth/user-not-found": "Wrong email or password.",
    "auth/wrong-password": "Wrong email or password.",
    "auth/email-already-in-use": "There's already an account with that email. Sign in instead.",
    "auth/weak-password": "Pick a password of at least 6 characters.",
    "auth/too-many-requests": "Too many tries. Wait a minute and try again.",
    "auth/popup-closed-by-user": "Sign-in was cancelled.",
    "auth/network-request-failed": "Can't reach the sign-in service. Check the connection.",
  };
  return new Error(msg[code] ?? (e as Error).message ?? "Something went wrong.");
}

export async function signInEmail(email: string, password: string) {
  try {
    await signInWithEmailAndPassword(auth, email.trim(), password);
  } catch (e) {
    throw friendly(e);
  }
}

export async function signInGoogle() {
  const provider = new GoogleAuthProvider();
  try {
    await signInWithPopup(auth, provider);
  } catch (e) {
    if ((e as { code?: string }).code === "auth/popup-blocked") return signInWithRedirect(auth, provider);
    throw friendly(e);
  }
}

/** Create an email account and claim its username in one go. */
export async function signUpEmail(username: string, email: string, password: string) {
  const name = username.trim().toLowerCase();
  if (!USERNAME_RE.test(name)) throw new Error("Usernames are 3-24 letters, digits, dots, dashes or underscores.");
  if (await usernameTaken(name)) throw new Error("That username is taken.");
  try {
    await createUserWithEmailAndPassword(auth, email.trim(), password);
  } catch (e) {
    throw friendly(e);
  }
  await claimUsername(name, name);
}

export async function usernameTaken(name: string) {
  const d = await getDoc(doc(db, "usernames", name.toLowerCase()));
  return d.exists() && d.data().uid !== auth.currentUser?.uid;
}

/** First sign-in (email sign-up, or Google the first time): pick a username. */
export async function claimUsername(username: string, displayName: string) {
  const u = auth.currentUser;
  if (!u) throw new Error("Sign in first.");
  const name = username.trim().toLowerCase();
  if (!USERNAME_RE.test(name)) throw new Error("Usernames are 3-24 letters, digits, dots, dashes or underscores.");
  const color = COLORS[[...u.uid].reduce((n, c) => n + c.charCodeAt(0), 0) % COLORS.length];
  await runTransaction(db, async (tx) => {
    const nameRef = doc(db, "usernames", name);
    const taken = await tx.get(nameRef);
    if (taken.exists() && taken.data().uid !== u.uid) throw new Error("That username is taken.");
    tx.set(nameRef, { uid: u.uid });
    tx.set(doc(db, "profiles", u.uid), {
      username: name,
      displayName: displayName.trim() || name,
      color,
      photoURL: u.photoURL ?? null,
      onboarded: false,
      createdAt: serverTimestamp(),
    });
  });
}

export const signOut = () => fbSignOut(auth);
