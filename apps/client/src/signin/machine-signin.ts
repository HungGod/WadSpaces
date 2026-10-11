// The web portal's page that signs a WadSpaces machine in with GitHub. The
// machine app opens it in a window of its own (src-tauri/src/github.rs):
// Firebase only runs GitHub's sign-in on an http(s) page, which the app isn't,
// so it runs here. The result goes back as the address of a page that doesn't
// exist (REPLY), which the window catches before anything loads.
//
// ?n=  the app's nonce, sent back with the result
// ?scopes=  what the GitHub token may do (github.toml), comma-separated
import { initializeApp } from "firebase/app";
import {
  GithubAuthProvider,
  browserPopupRedirectResolver,
  browserSessionPersistence,
  getRedirectResult,
  initializeAuth,
  signInWithRedirect,
  signOut,
} from "firebase/auth";

const REPLY = "https://signed-in.client.invalid/";
/** Set when this page has sent you to GitHub (per nonce): back without a result means it didn't finish. */
const STARTED = "wadspaces.machineSignin";

const env = import.meta.env;
// The redirect comes back through this host's /__/auth/handler, the address
// GitHub's OAuth App knows.
const app = initializeApp({
  apiKey: env.VITE_FIREBASE_API_KEY,
  authDomain: location.host,
  projectId: env.VITE_FIREBASE_PROJECT_ID,
  appId: env.VITE_FIREBASE_APP_ID,
});
const auth = initializeAuth(app, { persistence: browserSessionPersistence, popupRedirectResolver: browserPopupRedirectResolver });

const params = new URLSearchParams(location.search);
const nonce = params.get("n") ?? "";
const scopes = (params.get("scopes") ?? "").split(",").filter(Boolean);

function show(title: string, detail: string, retry = false) {
  document.getElementById("title")!.textContent = title;
  document.getElementById("detail")!.textContent = detail;
  document.getElementById("retry")!.hidden = !retry;
}

function reply(fields: Record<string, string>) {
  location.replace(`${REPLY}?${new URLSearchParams({ n: nonce, ...fields })}`);
}

function friendly(e: unknown): string {
  const code = (e as { code?: string }).code ?? "";
  const msg: Record<string, string> = {
    "auth/admin-restricted-operation": "New accounts are closed. Ask the owner to let your GitHub account in.",
    "auth/user-disabled": "This account is disabled.",
    "auth/network-request-failed": "Can't reach the sign-in service. Check the connection.",
    "auth/web-storage-unsupported": "This window can't keep the sign-in while it happens.",
  };
  return msg[code] ?? (e as Error).message ?? "Something went wrong.";
}

function readStarted() {
  try {
    return sessionStorage.getItem(STARTED);
  } catch {
    return null;
  }
}

async function start() {
  try {
    sessionStorage.setItem(STARTED, nonce);
  } catch {}
  show("Signing in with GitHub…", "Taking you to GitHub.");
  const provider = new GithubAuthProvider();
  scopes.forEach((s) => provider.addScope(s));
  await signInWithRedirect(auth, provider);
}

async function main() {
  if (!/^[0-9a-f]{32}$/.test(nonce)) {
    show("Open this from WadSpaces", "This page signs a WadSpaces machine in. Start from the app on the machine.");
    return;
  }
  const result = await getRedirectResult(auth);
  if (result) {
    const token = GithubAuthProvider.credentialFromResult(result)?.accessToken;
    const id = result.user.providerData.find((p) => p.providerId === "github.com")?.uid ?? "";
    // Nothing stays signed in here: the app signs in with the token itself.
    await signOut(auth).catch(() => {});
    if (!token) return reply({ error: "GitHub didn't send a token. Try again." });
    show("Signed in", "Back to WadSpaces…");
    return reply({ token, id });
  }
  if (readStarted() === nonce) {
    show("The sign-in didn't finish", "GitHub sent you back without signing in.", true);
    return;
  }
  await start();
}

document.getElementById("retry")!.addEventListener("click", () => start().catch((e) => reply({ error: friendly(e) })));
main().catch((e) => reply({ error: friendly(e) }));
