// What this build of Wad Creator can reach, fixed at build time (VITE_TARGET):
//
//   offline  wadd on this machine and no account (development, and machines
//            from before the app)
//   online   the web portal: your account, and your machines through the
//            cloud relay
//   machine  the app on a WadSpaces machine (Tauri): your account, and this
//            machine's wadd
//
// The checks are written out against import.meta.env so the bundler drops
// whatever a target doesn't use.

export type Target = "offline" | "online" | "machine";

export const TARGET: Target =
  import.meta.env.VITE_TARGET === "online" ? "online" : import.meta.env.VITE_TARGET === "machine" ? "machine" : "offline";

/** Signed in to a WadSpaces account (Firebase). */
export const hasAccount = import.meta.env.VITE_TARGET === "online" || import.meta.env.VITE_TARGET === "machine";

/** This machine's wadd is here: what's installed and running, projects, builds. */
export const hasLocal = import.meta.env.VITE_TARGET !== "online";

/** A browser that opens links in new tabs. The machine app opens none: show the address instead. */
export const canOpenLinks = import.meta.env.VITE_TARGET === "online";

/** Sign in with Google: only in a browser (its popup needs one). */
export const hasGoogleSignIn = import.meta.env.VITE_TARGET === "online";

/** The machine you're on, in machine lists and as a launch target. */
export const THIS_MACHINE = "this-machine";

export function isThisMachine(id: string | null | undefined): boolean {
  return hasLocal && id === THIS_MACHINE;
}
