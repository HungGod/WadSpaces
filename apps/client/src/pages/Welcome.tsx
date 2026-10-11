import { useNavigate } from "react-router";
import { useState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { AuthCard, FormError } from "@/components/AuthCard";
import { Button, Input, Label } from "@/components/ui";
import { USERNAME_RE, claimUsername, signOut, suggestedUsername } from "@/data/cloud/auth";
import { auth } from "@/data/cloud/firebase";

/** First sign-in, when the GitHub login can't be the username: pick one. */
export default function WelcomePage() {
  const navigate = useNavigate();
  const u = auth.currentUser;
  const [username, setUsername] = useState(suggestedUsername);
  const [displayName, setDisplayName] = useState(u?.displayName ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nameOk = USERNAME_RE.test(username);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await claimUsername(username, displayName || username);
      navigate("/", { replace: true });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <AuthCard>
      <form onSubmit={submit} className="ws-glass rounded-3xl border border-line p-7 shadow-deep">
        <h1 className="font-display text-2xl font-bold tracking-tight">One more thing</h1>
        <p className="mt-1 text-sm text-muted">Pick a username. It's how people find you to share wadspaces, and it can't be changed later.</p>
        <div className="mt-6 space-y-4">
          <div>
            <Label hint={username && !nameOk ? "3-24 letters, digits, . _ -" : undefined}>Username</Label>
            <Input autoFocus value={username} onChange={(e) => setUsername(e.target.value.toLowerCase())} />
          </div>
          <div>
            <Label>Display name</Label>
            <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={username} />
          </div>
        </div>
        <FormError message={error} />
        <Button type="submit" variant="primary" size="lg" className="mt-6 w-full" disabled={busy || !nameOk}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <>Continue <ArrowRight className="size-4" /></>}
        </Button>
        <p className="mt-5 text-center text-sm text-muted">
          Signed in as {u?.displayName ?? u?.email ?? "your GitHub account"}.{" "}
          <button type="button" className="font-medium hover:text-fg" onClick={() => signOut().then(() => navigate("/login", { replace: true }))}>
            Not you?
          </button>
        </p>
      </form>
    </AuthCard>
  );
}
