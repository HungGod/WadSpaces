import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import {
  GoogleAuthProvider,
  getRedirectResult,
  onAuthStateChanged,
  signInWithRedirect,
  signOut as fbSignOut,
  type User,
} from "firebase/auth";
import { auth, firebaseEnabled } from "./firebase";

interface AuthState {
  user: User | null;
  ready: boolean;
  error: string | null;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthState>({
  user: null,
  ready: true,
  error: null,
  signIn: async () => {},
  signOut: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(!firebaseEnabled);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!auth) return;
    getRedirectResult(auth).catch((e) => setError(e.message));
    return onAuthStateChanged(auth, (u) => {
      setUser(u);
      setReady(true);
    });
  }, []);

  const value: AuthState = {
    user,
    ready,
    error,
    // Redirect, not a popup: the kiosk runs one fullscreen window and popups
    // would open on top with no way back.
    signIn: async () => {
      if (auth) await signInWithRedirect(auth, new GoogleAuthProvider());
    },
    signOut: async () => {
      if (auth) await fbSignOut(auth);
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
