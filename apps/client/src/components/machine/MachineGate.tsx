// The machine app's first run (setup.ts has the order): Wi-Fi until the
// machine is online, then the sign-in pages, then linking the machine to the
// account and signing it in to GitHub. After that (and on every later start)
// it's the app, with MachineChrome over it.
import { useCallback, useEffect, useState } from "react";
import { useLocation } from "react-router";
import { ArrowRight, Link2, Loader2, LogOut, TriangleAlert } from "lucide-react";
import { backend } from "@/data";
import type { MachineBackend } from "@/data/machine";
import { onAuthUser } from "@/data/cloud/auth";
import { AuthCard } from "../AuthCard";
import { Button } from "../ui";
import { GithubSignIn } from "./GithubSignIn";
import { MachineChrome } from "./MachineChrome";
import { nextSetupStep, type SetupStep } from "./setup";
import { isOnline, useWaddState } from "./useWadd";
import { WifiPanel } from "./WifiPanel";

const machine = () => backend as MachineBackend;
/** wadd's words for a token GitHub refuses (wadd/github.py REFUSED). */
const refused = (error?: string) => !!error && /refused|revoked|bad credentials|401/i.test(error);
const SKIP_KEY = (uid: string) => `wadcreator.githubLater.${uid}`;

function readSkip(uid: string | null) {
  try {
    return !!uid && localStorage.getItem(SKIP_KEY(uid)) === "1";
  } catch {
    return false;
  }
}

function Card({ title, subtitle, children, wide }: { title: string; subtitle?: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <AuthCard wide={wide}>
      <div className="ws-glass rounded-3xl border border-line p-7 shadow-deep">
        <h1 className="font-display text-2xl font-bold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
        <div className="mt-6">{children}</div>
      </div>
    </AuthCard>
  );
}

/** Links this machine to the signed-in account: a one-time code from the
 *  account, redeemed by wadd (it then heartbeats and syncs as this user). */
function LinkStep({ online, machineName, relink }: { online: boolean; machineName: string; relink: boolean }) {
  const [state, setState] = useState<"idle" | "busy" | { error: string }>(relink ? "idle" : "busy");

  const link = useCallback(async () => {
    setState("busy");
    try {
      const code = await machine().createEnrollCode(machineName);
      await machine().linkMachine(code);
      // wadd's next snapshot has the new owner; the gate moves on from there.
    } catch (e) {
      setState({ error: (e as Error).message });
    }
  }, [machineName]);

  useEffect(() => {
    if (!relink && online) link();
  }, [relink, online, link]);

  if (!online) {
    return (
      <Card title="Connect to Wi-Fi" subtitle="Linking this machine to your account needs the internet." wide>
        <WifiPanel />
      </Card>
    );
  }
  if (relink && state === "idle") {
    return (
      <Card title="This machine is someone else's" subtitle={`${machineName} is linked to another WadSpaces account.`}>
        <div className="flex items-start gap-3 rounded-2xl bg-danger/10 px-4 py-3 text-sm ring-1 ring-danger/30">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-danger" />
          <span>Linking it to your account takes it away from theirs. Their projects and GitHub sign-in are removed from this machine; the files stay on its disk.</span>
        </div>
        <div className="mt-6 flex gap-2">
          <Button variant="primary" className="flex-1" onClick={link}>
            <Link2 className="size-4" /> Link it to my account
          </Button>
          <Button onClick={() => backend.signOut()}>
            <LogOut className="size-4" /> Sign out
          </Button>
        </div>
      </Card>
    );
  }
  return (
    <Card title="Linking this machine" subtitle={`${machineName}, to your account.`}>
      {state === "busy" ? (
        <div className="flex items-center gap-3 text-sm text-muted">
          <Loader2 className="size-4 animate-spin" /> One moment…
        </div>
      ) : typeof state === "object" ? (
        <div className="space-y-4">
          <p className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger ring-1 ring-danger/30">{state.error}</p>
          <Button variant="primary" onClick={link}>
            Try again
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

export default function MachineGate({ children }: { children: React.ReactNode }) {
  const snap = useWaddState();
  const { pathname } = useLocation();
  const [uid, setUid] = useState<string | null | undefined>(undefined);
  const [hasProfile, setHasProfile] = useState(false);
  const [github, setGithub] = useState<boolean | null>(null);
  const [skipped, setSkipped] = useState(false);
  const [waited, setWaited] = useState(false);

  // Who's signed in (Firebase remembers them across reboots, offline too).
  useEffect(
    () =>
      onAuthUser((u) => {
        setUid(u?.uid ?? null);
        setSkipped(readSkip(u?.uid ?? null));
        setHasProfile(false);
        if (u) backend.me().then((me) => setHasProfile(!!me), () => setHasProfile(false));
      }),
    [],
  );
  // The username is picked on /welcome; it's done once we're past it.
  useEffect(() => {
    if (uid && !hasProfile && pathname !== "/welcome") backend.me().then((me) => setHasProfile(!!me), () => {});
  }, [uid, hasProfile, pathname]);

  const linked = !!uid && snap?.owner_uid === uid;
  // Whether this machine has a working GitHub token, once it's this user's. A
  // refused one (revoked, like the old baked-in token) counts as none; one
  // that can't be checked offline counts as fine.
  const checkGithub = useCallback(() => {
    backend.githubStatus().then((s) => setGithub(s.token && !refused(s.error)), () => setGithub(false));
  }, []);
  useEffect(() => {
    if (linked) checkGithub();
    return backend.subscribe((t) => t === "github" && linked && checkGithub());
  }, [linked, checkGithub]);

  // Without wadd there's nothing to set up here: don't hold the app hostage.
  useEffect(() => {
    const t = setTimeout(() => setWaited(true), 3000);
    return () => clearTimeout(t);
  }, []);

  if (uid === undefined || (!snap && !waited)) {
    return (
      <div className="ws-backdrop grid h-screen place-items-center text-muted">
        <Loader2 className="size-6 animate-spin" />
      </div>
    );
  }

  let step: SetupStep = "done";
  if (snap) {
    step = nextSetupStep({
      online: isOnline(snap),
      signedIn: !!uid,
      uid: uid ?? null,
      // A wadd without cloud settings (a dev laptop) can't be linked: take it as yours.
      ownerUid: snap.cloud_enabled === false ? (uid ?? null) : (snap.owner_uid ?? null),
      github: github ?? true, // unknown yet: don't flash the step
      githubSkipped: skipped,
    });
  }
  // Signing in and picking a username are the app's own pages.
  if (step !== "wifi" && (!uid || !hasProfile)) step = "done";

  const screen = (() => {
    switch (step) {
      case "wifi":
        return (
          <Card title="Connect to Wi-Fi" subtitle="This machine needs the internet to sign you in." wide>
            <WifiPanel />
          </Card>
        );
      case "link":
      case "relink":
        return <LinkStep online={isOnline(snap)} machineName={snap?.machine ?? "WadSpaces machine"} relink={step === "relink"} />;
      case "github":
        return (
          <Card title="Sign in to GitHub" subtitle="Your projects are GitHub repositories: this lets the machine clone, pull and push them." wide>
            <GithubSignIn />
            <div className="mt-6 flex justify-end">
              <Button
                variant="ghost"
                onClick={() => {
                  try {
                    localStorage.setItem(SKIP_KEY(uid!), "1");
                  } catch {}
                  setSkipped(true);
                }}
              >
                Later <ArrowRight className="size-4" />
              </Button>
            </div>
          </Card>
        );
      default:
        return children;
    }
  })();

  return (
    <>
      {screen}
      <MachineChrome />
    </>
  );
}
