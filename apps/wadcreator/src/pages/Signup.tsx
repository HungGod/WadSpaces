import { Link, useNavigate } from "react-router";
import { useState } from "react";
import { ArrowLeft, Loader2 } from "lucide-react";
import { AuthCard, FormError, GoogleButton, OrDivider } from "@/components/AuthCard";
import { Button, Input, Label } from "@/components/ui";
import { USERNAME_RE, signInGoogle, signUpEmail } from "@/data/cloud/auth";

export default function SignupPage() {
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nameOk = USERNAME_RE.test(username.trim().toLowerCase());

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      navigate("/", { replace: true });
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
          run(() => signUpEmail(username, email, password));
        }}
        className="ws-glass rounded-3xl border border-line p-7 shadow-deep"
      >
        <h1 className="font-display text-2xl font-bold tracking-tight">Create account</h1>
        <p className="mt-1 text-sm text-muted">Pick a username. It's how people find you to share wadspaces.</p>

        <GoogleButton className="mt-6" label="Sign up with Google" disabled={busy} onClick={() => run(signInGoogle)} />
        <OrDivider />

        <div className="space-y-4">
          <div>
            <Label hint={username && !nameOk ? "3-24 letters, digits, . _ -" : undefined}>Username</Label>
            <Input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value.toLowerCase())} />
          </div>
          <div>
            <Label>Email</Label>
            <Input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div>
            <Label hint="at least 6 characters">Password</Label>
            <Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
          </div>
        </div>

        <FormError message={error} />

        <Button type="submit" variant="primary" size="lg" className="mt-6 w-full" disabled={busy || !nameOk || !email.trim() || password.length < 6}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : "Create account"}
        </Button>

        <p className="mt-5 text-center text-sm text-muted">
          <Link to="/login" className="inline-flex items-center gap-1 font-medium hover:text-fg">
            <ArrowLeft className="size-3.5" /> Back to sign in
          </Link>
        </p>
      </form>
    </AuthCard>
  );
}
