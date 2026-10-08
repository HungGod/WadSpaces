// First run on a machine, one step at a time: Wi-Fi (until it's online),
// sign in, link the machine to the account, sign it in to GitHub. Sign-in
// and the username are the app's own pages (/login, /signup, /welcome); the
// rest is MachineSetup. Each step stays done: a machine that reboots offline
// after the first run goes straight to the app.

export type SetupStep = "wifi" | "signin" | "link" | "relink" | "github" | "done";

export interface SetupState {
  /** NetworkManager's connectivity is "full". */
  online: boolean;
  /** Firebase has a signed-in user (it remembers one offline). */
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
