// First run on a machine, one step at a time: Wi-Fi (until it's online),
// sign in with GitHub, link the machine to the account. Signing in gives the
// machine its GitHub token too; the GitHub step is for when it didn't stick
// (revoked, or the app restarted before linking). Sign-in and the username
// are the app's own pages (/login, /welcome); the rest is MachineGate. Every
// boot signs out (machine/boot.ts), so each boot starts at Wi-Fi or sign-in;
// linking and GitHub stay done.

export type SetupStep = "wifi" | "signin" | "link" | "relink" | "github" | "done";

export interface SetupState {
  /** NetworkManager's connectivity is "full". */
  online: boolean;
  /** Firebase has a signed-in user (it remembers one until the next boot). */
  signedIn: boolean;
  /** This user's uid, when signed in. */
  uid: string | null;
  /** Whose machine wadd says this is (null: not linked yet). */
  ownerUid: string | null;
  /** The machine has a GitHub token. */
  github: boolean;
  /** "Later" pressed on the GitHub step (per user). */
  githubSkipped: boolean;
}

export function nextSetupStep(s: SetupState): SetupStep {
  if (!s.signedIn) return s.online ? "signin" : "wifi";
  if (s.ownerUid !== s.uid) return s.ownerUid ? "relink" : "link";
  if (!s.github && !s.githubSkipped) return "github";
  return "done";
}
