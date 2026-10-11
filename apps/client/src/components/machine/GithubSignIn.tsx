// This machine's GitHub token. Signing in to WadSpaces is signing in with
// GitHub (data/cloud/auth.ts signInGithub), and the token from that waits in
// the app's Rust side (src-tauri/src/github.rs) until the machine is yours:
// then it goes to wadd (git, `gh`, packages, the repo list) and to your
// account, where your other machines fetch it. This is for signing in again:
// a token that was revoked, or a sign-in from before the machine was linked.
import { useEffect, useRef, useState } from "react";
import { Check, FolderGit2, Loader2 } from "lucide-react";
import { backend } from "@/data";
import type { MachineBackend } from "@/data/machine";
import { githubIdNow } from "@/data/cloud/auth";
import { commands } from "@/gen/bindings";
import { GithubButton } from "../AuthCard";
import { Modal } from "../ui";

type State = { kind: "idle" } | { kind: "busy"; window: boolean } | { kind: "done"; login: string; savedToAccount: boolean } | { kind: "error"; message: string };

/** The signed-in user, for saving the token to their account (Firestore rules apply). */
async function accountRef() {
  const { auth, app } = await import("@/data/cloud/firebase");
  const u = auth.currentUser;
  const projectId = app.options.projectId;
  if (!u || !projectId) return null;
  return { uid: u.uid, idToken: await u.getIdToken(), projectId };
}

/** Puts the last sign-in's token in place, if it's the signed-in user's
 *  GitHub account. Call once the machine is theirs. */
export async function savePendingGithub() {
  const p = await commands.githubPending();
  if (!p || !p.githubId || p.githubId !== githubIdNow()) return null;
  const done = await commands.githubSaveToken(await accountRef());
  (backend as MachineBackend).githubSignedIn?.();
  return done;
}

const errorText = (e: unknown) => {
  const err = e as { code?: string; message?: string };
  return err.code === "cancelled" ? "Sign-in was cancelled." : (err.message ?? String(e));
};

export function GithubSignIn({ onDone }: { onDone?: (login: string) => void }) {
  const [state, setState] = useState<State>({ kind: "busy", window: false });
  const run = useRef(0);
  const windowOpen = useRef(false);

  const finish = (done: { account: { login: string }; savedToAccount: boolean }) => {
    setState({ kind: "done", login: done.account.login, savedToAccount: done.savedToAccount });
    onDone?.(done.account.login);
  };

  // A sign-in's token may be waiting already.
  useEffect(() => {
    const mine = ++run.current;
    savePendingGithub().then(
      (done) => mine === run.current && (done ? finish(done) : setState({ kind: "idle" })),
      (e) => mine === run.current && setState({ kind: "error", message: errorText(e) }),
    );
    return () => {
      run.current++;
      // Closing the dialog closes GitHub's page too.
      if (windowOpen.current) commands.githubSignInCancel().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const signIn = async () => {
    const mine = ++run.current;
    setState({ kind: "busy", window: true });
    try {
      const { app } = await import("@/data/cloud/firebase");
      windowOpen.current = true;
      const c = await commands.githubSignIn(app.options.authDomain ?? "").finally(() => (windowOpen.current = false));
      if (mine !== run.current) return;
      const want = githubIdNow();
      if (c.githubId !== want) {
        setState({ kind: "error", message: `That's ${c.account.login}: sign in with the GitHub account you use for WadSpaces.` });
        return;
      }
      const done = await savePendingGithub();
      if (mine !== run.current) return;
      if (done) finish(done);
      else setState({ kind: "error", message: "The sign-in finished, but its token wasn't there to save. Try again." });
    } catch (e) {
      if (mine === run.current) setState({ kind: "error", message: errorText(e) });
    }
  };

  if (state.kind === "done") {
    return (
      <div className="flex items-start gap-3 rounded-2xl bg-accent-soft px-4 py-3 ring-1 ring-accent/30">
        <Check className="mt-0.5 size-5 text-accent" />
        <div className="text-sm">
          <div className="font-semibold">Signed in to GitHub as {state.login}</div>
          <div className="text-muted">
            {state.savedToAccount ? "Your other machines pick it up from your account too." : "This machine only: it couldn't be saved to your account just now."}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      {state.kind === "error" && <p className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger ring-1 ring-danger/30">{state.message}</p>}
      <GithubButton disabled={state.kind === "busy"} onClick={signIn} label={state.kind === "error" ? "Try again" : "Sign in with GitHub"} />
      {state.kind === "busy" && (
        <p className="flex items-center gap-2 text-sm text-muted">
          <Loader2 className="size-4 shrink-0 animate-spin" />
          {state.window ? "Finish signing in on GitHub's page. Close it (Ctrl+W) to cancel." : "One moment…"}
        </p>
      )}
    </div>
  );
}

export function GithubSignInDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      width={480}
      title={
        <span className="flex items-center gap-2">
          <FolderGit2 className="size-5" /> Sign in to GitHub
        </span>
      }
      subtitle="So this machine can clone, pull and push your repositories and packages."
    >
      {open && <GithubSignIn />}
    </Modal>
  );
}
