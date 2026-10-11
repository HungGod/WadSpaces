import { useNavigate, useSearchParams } from "react-router";
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { AuthCard, FormError, GithubButton } from "@/components/AuthCard";
import { TARGET } from "@/lib/machine";
import { signInGithub } from "@/data/cloud/auth";

export default function LoginPage() {
  const navigate = useNavigate();
  const next = useSearchParams()[0].get("next") || "/";
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const signIn = async () => {
    setBusy(true);
    setError(null);
    try {
      await signInGithub();
      navigate(next, { replace: true });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <AuthCard>
      <div className="ws-glass rounded-3xl border border-line p-7 shadow-deep">
        <h1 className="font-display text-2xl font-bold tracking-tight">Welcome</h1>
        <p className="mt-1 text-sm text-muted">Sign in with GitHub to build and run your wadspaces. Your projects are your GitHub repositories.</p>
        <GithubButton className="mt-6" disabled={busy} onClick={signIn} />
        {busy && TARGET === "machine" && (
          <p className="mt-4 flex items-center gap-2 text-sm text-muted">
            <Loader2 className="size-4 shrink-0 animate-spin" /> Finish signing in on GitHub's page. Close it (Ctrl+W) to cancel.
          </p>
        )}
        <FormError message={error} />
      </div>
    </AuthCard>
  );
}
