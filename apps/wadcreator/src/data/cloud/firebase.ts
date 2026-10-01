// Firebase for the online app. Config comes from .env.local (see
// .env.example); VITE_USE_EMULATORS=1 points everything at the local
// emulator suite (`firebase emulators:start`).
import { initializeApp } from "firebase/app";
import { connectAuthEmulator, getAuth } from "firebase/auth";
import { connectFirestoreEmulator, getFirestore } from "firebase/firestore";

const env = import.meta.env;
const emulators = env.VITE_USE_EMULATORS === "1";

const config = {
  apiKey: env.VITE_FIREBASE_API_KEY || (emulators ? "emulator-key" : undefined),
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID || (emulators ? "demo-wadcreator" : undefined),
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: env.VITE_FIREBASE_APP_ID,
};

if (!config.apiKey || !config.projectId) {
  throw new Error("The online app needs VITE_FIREBASE_* in .env.local (or VITE_USE_EMULATORS=1).");
}

export const app = initializeApp(config);
export const auth = getAuth(app);
export const db = getFirestore(app);

if (emulators) {
  const host = env.VITE_EMULATOR_HOST || "127.0.0.1";
  connectAuthEmulator(auth, `http://${host}:9099`, { disableWarnings: true });
  connectFirestoreEmulator(db, host, 8090);
}
