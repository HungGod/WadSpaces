// Signing this machine in to GitHub: the device flow, run by the app's Rust
// side (src-tauri/src/github.rs). The page shows the code; the token never
// comes here. Once it's in, this machine's git and `gh` work, the repo list
// loads, and your other machines fetch the same token from your account.
import { useEffect, useRef, useState } from "react";
import { Check, ClipboardCheck, FolderGit2, Loader2, Monitor, RefreshCw } from "lucide-react";
import { backend } from "@/data";
import type { MachineBackend } from "@/data/machine";
import { commands, type DevicePrompt } from "@/gen/bindings";
import { copyText } from "@/lib/clipboard";
import { Button, Modal } from "../ui";

type State =
  | { kind: "starting" }
  | { kind: "code"; prompt: DevicePrompt; expiresAt: number }
  | { kind: "done"; login: string; savedToAccount: boolean }
  | { kind: "error"; message: string };

/** The signed-in user, for saving the token to their account (Firestore rules apply). */
async function accountRef() {
  const { auth, app } = await import("@/data/cloud/firebase");
  const u = auth.currentUser;
  const projectId = app.options.projectId;
  if (!u || !projectId) return null;
  return { uid: u.uid, idToken: await u.getIdToken(), projectId };
}

const errorText = (e: unknown) => (e as { message?: string })?.message ?? String(e);

export function GithubSignIn({ onDone }: { onDone?: (login: string) => void }) {
  const [state, setState] = useState<State>({ kind: "starting" });
  const [now, setNow] = useState(Date.now());
  const [here, setHere] = useState<"idle" | "open" | { error: string }>("idle");
  const run = useRef(0);

  const start = async () => {
    const mine = ++run.current;
    setState({ kind: "starting" });
    try {
      const prompt = await commands.githubDeviceStart();
      if (mine !== run.current) return;
      setState({ kind: "code", prompt, expiresAt: Date.now() + prompt.code.expiresIn * 1000 });
      const done = await commands.githubDeviceWait(await accountRef());
      if (mine !== run.current) return;
      (backend as MachineBackend).githubSignedIn?.();
      setState({ kind: "done", login: done.account.login, savedToAccount: done.savedToAccount });
      onDone?.(done.account.login);
    } catch (e) {
      if (mine !== run.current) return;
      const err = e as { code?: string };
      setState({ kind: "error", message: err.code === "cancelled" ? "The code expired or the sign-in was cancelled." : errorText(e) });
    }
  };

  useEffect(() => {
    start();
    return () => {
      run.current++;
      commands.githubDeviceCancel().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (state.kind !== "code") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [state.kind]);

  if (state.kind === "starting") {
    return (
      <div className="grid place-items-center py-10 text-muted">
        <Loader2 className="size-6 animate-spin" />
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="space-y-4">
        <p className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger ring-1 ring-danger/30">{state.message}</p>
        <Button onClick={start}>
          <RefreshCw className="size-4" /> Try again
        </Button>
      </div>
    );
  }
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

  const { code, qrSvg } = state.prompt;
  const left = Math.max(0, Math.round((state.expiresAt - now) / 1000));
  // GitHub's page in Chromium, over the app; the code goes on the clipboard
  // first (during the click, as WebKit wants) to paste there.
  const signInHere = async () => {
    try {
      await copyText(code.userCode).catch(() => {});
      await commands.githubOpenBrowser();
      setHere("open");
    } catch (e) {
      setHere({ error: errorText(e) });
    }
  };
  return (
    <div className="grid items-center gap-6 sm:grid-cols-[1fr_auto]">
      <div className="space-y-4">
        <Button variant="primary" className="w-full" onClick={signInHere}>
          <Monitor className="size-4" /> Sign in on this machine
        </Button>
        {here === "open" && (
          <p className="flex items-start gap-2 text-sm text-muted">
            <ClipboardCheck className="mt-0.5 size-4 shrink-0 text-accent" />
            <span>The code is copied. On GitHub's page, paste it with Ctrl+V, then sign in. The page closes when you're done (or close it with Ctrl+W).</span>
          </p>
        )}
        {typeof here === "object" && <p className="text-sm text-danger">{here.error}</p>}
        <p className="text-sm text-muted">
          Or on your phone or computer: go to <span className="font-mono text-fg">{code.verificationUri.replace(/^https:\/\//, "")}</span> (or scan the code) and enter:
        </p>
        <div className="select-all rounded-2xl bg-surface-2 px-5 py-4 text-center font-mono text-4xl font-bold tracking-[0.2em] ring-1 ring-line-strong">{code.userCode}</div>
        <p className="flex items-center gap-2 text-xs text-faint">
          <Loader2 className="size-3.5 animate-spin" /> Waiting for GitHub · {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")} left
        </p>
      </div>
      {qrSvg && <img src={`data:image/svg+xml;utf8,${encodeURIComponent(qrSvg)}`} alt="QR code of the GitHub address" className="size-44 rounded-xl bg-white p-2" />}
    </div>
  );
}

export function GithubSignInDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      width={600}
      title={
        <span className="flex items-center gap-2">
          <FolderGit2 className="size-5" /> Sign in to GitHub
        </span>
      }
      subtitle="So this machine can clone, pull and push your repositories."
    >
      {open && <GithubSignIn />}
    </Modal>
  );
}
