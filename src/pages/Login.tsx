import { Link, useNavigate, useSearchParams } from "react-router";
import { useState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { AuthCard, FormError, GoogleButton, OrDivider } from "@/components/AuthCard";
import { Button, Input, Label } from "@/components/ui";
import { signInEmail, signInGoogle } from "@/data/cloud/auth";

export default function LoginPage() {
  const navigate = useNavigate();
  const next = useSearchParams()[0].get("next") || "/";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      navigate(next, { replace: true });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <AuthCard>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run(() => signInEmail(email, password));
        }}
        className="ws-glass rounded-3xl border border-line p-7 shadow-deep"
      >
        <h1 className="font-display text-2xl font-bold tracking-tight">Welcome back</h1>
        <p className="mt-1 text-sm text-muted">Sign in to build, run and stream your wadspaces.</p>

        <GoogleButton className="mt-6" disabled={busy} onClick={() => run(signInGoogle)} />
        <OrDivider />

        <div className="space-y-4">
          <div>
            <Label>Email</Label>
            <Input type="email" autoFocus autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div>
            <Label>Password</Label>
            <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
          </div>
        </div>

        <FormError message={error} />

        <Button type="submit" variant="primary" size="lg" className="mt-6 w-full" disabled={busy || !email.trim() || !password}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <>Sign in <ArrowRight className="size-4" /></>}
        </Button>

        <p className="mt-5 text-center text-sm text-muted">
          New to WAD SPACES?{" "}
          <Link to="/signup" className="font-semibold text-accent hover:underline">
            Create account
          </Link>
        </p>
      </form>
    </AuthCard>
  );
}
