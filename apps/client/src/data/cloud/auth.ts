// Accounts: Firebase Auth with GitHub, plus a WadSpaces profile with a
// unique username (your GitHub login, when it's free). The username is
// claimed in one transaction — usernames/{name} and profiles/{uid} together —
// and firestore.rules make sure nobody can take someone else's.
//
// The web portal signs in with Firebase's GitHub popup. The machine app can't
// (Firebase's popup needs an http(s) page): its Rust side runs the sign-in in
// a window on the portal (src-tauri/src/github.rs) and hands back GitHub's
// token, which signs Firebase in here.
import {
  GithubAuthProvider,
  getAdditionalUserInfo,
  onAuthStateChanged,
  signInWithCredential,
  signInWithPopup,
  signOut as fbSignOut,
  type User,
} from "firebase/auth";
import { doc, getDoc, runTransaction, serverTimestamp } from "firebase/firestore";
import { app, auth, db } from "./firebase";

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
  const err = e as { code?: string; message?: string };
  const code = err.code ?? "";
  const msg: Record<string, string> = {
    cancelled: "Sign-in was cancelled.",
    "auth/popup-closed-by-user": "Sign-in was cancelled.",
    "auth/cancelled-popup-request": "Sign-in was cancelled.",
    "auth/popup-blocked": "The browser blocked GitHub's sign-in window. Allow pop-ups for this site and try again.",
    "auth/admin-restricted-operation": "New accounts are closed. Ask the owner to let your GitHub account in.",
    "auth/user-disabled": "This account is disabled.",
    "auth/too-many-requests": "Too many tries. Wait a minute and try again.",
    "auth/network-request-failed": "Can't reach the sign-in service. Check the connection.",
  };
  return new Error(msg[code] ?? err.message ?? String(e) ?? "Something went wrong.");
}

/** The GitHub login of the last sign-in, for /welcome when it can't be the username. */
let lastLogin: string | null = null;
export const suggestedUsername = () => (lastLogin ?? "").toLowerCase().replace(/[^a-z0-9_.-]/g, "").slice(0, 24);

/** Sign in (or sign up) with GitHub. */
export async function signInGithub() {
  try {
    if (import.meta.env.VITE_TARGET === "machine") {
      const { commands } = await import("@/gen/bindings");
      const authDomain = app.options.authDomain;
      if (!authDomain) throw new Error("The app has no Firebase auth domain (VITE_FIREBASE_AUTH_DOMAIN).");
      const c = await commands.githubSignIn(authDomain);
      await signInWithCredential(auth, GithubAuthProvider.credential(c.accessToken));
      await ensureProfile(c.account.login, c.account.name);
    } else {
      const r = await signInWithPopup(auth, new GithubAuthProvider());
      await ensureProfile(getAdditionalUserInfo(r)?.username ?? null, r.user.displayName);
    }
  } catch (e) {
    throw friendly(e);
  }
}

/** The GitHub account the signed-in user signed in with: its numeric id. */
export function githubIdNow(): string | null {
  return auth.currentUser?.providerData.find((p) => p.providerId === "github.com")?.uid ?? null;
}

/** First sign-in: the profile, named after the GitHub login when that's a
 *  free username. Otherwise /welcome asks for one. */
async function ensureProfile(login: string | null, name: string | null | undefined) {
  lastLogin = login;
  const u = auth.currentUser;
  if (!u || (await getDoc(doc(db, "profiles", u.uid))).exists()) return;
  const want = suggestedUsername();
  if (!USERNAME_RE.test(want) || (await usernameTaken(want))) return;
  await claimUsername(want, name || login || want).catch(() => {});
}

export async function usernameTaken(name: string) {
  const d = await getDoc(doc(db, "usernames", name.toLowerCase()));
  return d.exists() && d.data().uid !== auth.currentUser?.uid;
}

/** First sign-in: claim a username (ensureProfile, or /welcome). */
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
