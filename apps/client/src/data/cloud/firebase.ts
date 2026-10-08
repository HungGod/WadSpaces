// Firebase for the online app and the machine app. Config comes from
// .env.local (see .env.example); VITE_USE_EMULATORS=1 points everything at the
// local emulator suite (`firebase emulators:start`).
//
// The machine app (WebKitGTK, tauri://localhost) keeps the sign-in in
// IndexedDB and loads no popup/redirect helper: it signs in with email and
// password only, and Google's helper script is outside its CSP. Firestore
// keeps a persistent cache there, so the app starts with your designs even
// when the machine boots offline.
import { initializeApp } from "firebase/app";
import { browserLocalPersistence, connectAuthEmulator, getAuth, indexedDBLocalPersistence, initializeAuth } from "firebase/auth";
import { connectFirestoreEmulator, getFirestore, initializeFirestore, persistentLocalCache, persistentSingleTabManager } from "firebase/firestore";

const env = import.meta.env;
const emulators = env.VITE_USE_EMULATORS === "1";

const config = {
  apiKey: env.VITE_FIREBASE_API_KEY || (emulators ? "emulator-key" : undefined),
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID || (emulators ? "demo-client" : undefined),
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: env.VITE_FIREBASE_APP_ID,
};

if (!config.apiKey || !config.projectId) {
  throw new Error("The online app needs VITE_FIREBASE_* in .env.local (or VITE_USE_EMULATORS=1).");
}

export const app = initializeApp(config);
const machine = import.meta.env.VITE_TARGET === "machine";
export const auth = machine ? initializeAuth(app, { persistence: [indexedDBLocalPersistence, browserLocalPersistence] }) : getAuth(app);
export const db = machine ? initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentSingleTabManager(undefined) }) }) : getFirestore(app);

if (emulators) {
  const host = env.VITE_EMULATOR_HOST || "127.0.0.1";
  connectAuthEmulator(auth, `http://${host}:9099`, { disableWarnings: true });
  connectFirestoreEmulator(db, host, 8090);
}
