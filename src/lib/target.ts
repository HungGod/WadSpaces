// Wad Creator is built twice from this code:
//   offline  the desktop app on a WadSpaces machine (desktop/, Electron). It
//            manages that machine through wadd on 127.0.0.1:8080; no account.
//   online   the web app. Signed in with Google, it reaches your machines
//            through wadd's cloud relay (Firestore commands) and keeps your
//            workspace designs in your account.
// Chosen at build time: VITE_TARGET=offline (default) | online.
export type Target = "offline" | "online";
export const TARGET: Target = import.meta.env.VITE_TARGET === "online" ? "online" : "offline";
export const isOnline = TARGET === "online";
