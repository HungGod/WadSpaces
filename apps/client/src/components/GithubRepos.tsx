import { useCallback, useEffect, useState } from "react";
import { Check, ClipboardCopy, KeyRound, Loader2, Lock, Plus, RefreshCw } from "lucide-react";
import clsx from "clsx";
import { backend } from "@/data";
import { REPO_NAME_RE, freeMountName, type Project } from "@core/projects";
import { useApp } from "@/lib/store";
import { Button, Input, Label, Modal, Toggle } from "./ui";
import { canOpenLinks } from "@/lib/machine";
import { TARGET } from "@/lib/machine";
import { openMachinePanel } from "./machine/panels";

const TOKEN_CMD = "printf '%s' '<PAT>' | podman secret create github_token -";
export const GITHUB_NEW = "https://github.com/new";

/** A link where the app can open one (a browser); plain text in the machine's own app, which opens none. */
export function OutLink({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) {
  if (!canOpenLinks) return <span className={className}>{children}</span>;
  return (
    <a href={href} target="_blank" rel="noreferrer" className={clsx("underline decoration-line-strong underline-offset-2 hover:text-fg", className)}>
      {children}
    </a>
  );
}

/**
 * Why there's no repo list. Offline: this machine has no github_token, and
 * how to add one. Online: none of your machines has shared the list yet.
 */
export function GithubTokenCallout({ missing, onRetry, busy }: { missing: "token" | "shared"; onRetry?: () => void; busy?: boolean }) {
  const [copied, setCopied] = useState(false);
  // The machine app signs the machine in itself.
  if (TARGET === "machine" && missing === "token") {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-accent-2-soft p-4 text-sm ring-1 ring-accent-2/45">
        <KeyRound className="size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="font-semibold">This machine isn't signed in to GitHub</div>
          <p className="text-muted">Projects are your GitHub repositories. Sign in once and this machine can list, clone and push them.</p>
        </div>
        <Button variant="primary" size="sm" onClick={() => openMachinePanel("github")}>
          Sign in to GitHub
        </Button>
      </div>
    );
  }
  const copy = async () => {
    await navigator.clipboard.writeText(TOKEN_CMD).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
  return (
    <div className="space-y-3 rounded-2xl bg-accent-2-soft p-4 text-sm ring-1 ring-accent-2/45">
      <div className="flex items-start gap-2.5">
        <KeyRound className="mt-0.5 size-4 shrink-0" />
        {missing === "token" ? (
          <div className="space-y-1.5">
            <div className="font-semibold">This machine has no GitHub token</div>
            <p className="text-muted">
              Projects are your GitHub repositories, cloned with the machine's <span className="font-mono">github_token</span> secret. Make a token at{" "}
              <OutLink href="https://github.com/settings/tokens" className="font-mono">github.com/settings/tokens</OutLink> (a classic one with the <b>repo</b> scope, or a
              fine-grained one with Contents and Administration read and write), then on this machine run:
            </p>
          </div>
        ) : (
          <div className="space-y-1.5">
            <div className="font-semibold">No machine has shared your GitHub repos yet</div>
            <p className="text-muted">
              The token stays on your machines, so they list your repositories for this page. Open WadSpaces on one of them (it needs the{" "}
              <span className="font-mono">github_token</span> secret there), or press Refresh to ask the ones that are online.
            </p>
          </div>
        )}
      </div>
      {missing === "token" && (
        <div className="flex items-center gap-2 rounded-xl bg-[#07040f] px-3 py-2 font-mono text-[12px] text-[#e9e3ff] ring-1 ring-white/10">
          <span className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap">{TOKEN_CMD}</span>
          <button type="button" onClick={copy} className="grid size-7 shrink-0 place-items-center rounded-lg text-white/60 hover:bg-white/10 hover:text-white" aria-label="Copy">
            {copied ? <Check className="size-3.5" /> : <ClipboardCopy className="size-3.5" />}
          </button>
        </div>
      )}
      {onRetry && (
        <div className="flex justify-end">
          <Button size="sm" onClick={onRetry} disabled={busy}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} {missing === "token" ? "Check again" : "Refresh"}
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * New repo. On a machine: wadd makes it on GitHub (private unless you say).
 * Online there's no token here, so it's github.com/new.
 */
export function NewRepoDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated?: (p: Project) => void }) {
  const projects = useApp((s) => s.projects);
  const toast = useApp((s) => s.toast);
  const loadProjects = useApp((s) => s.loadProjects);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [priv, setPriv] = useState(true);
  const [setup, setSetup] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<boolean | null>(null);
  const [login, setLogin] = useState<string | null>(null);

  const check = useCallback(async () => {
    try {
      const s = await backend.githubStatus();
      setToken(s.token);
      setLogin(s.login);
      setError(s.error ?? null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setName("");
    setDescription("");
    setPriv(true);
    setSetup("");
    setError(null);
    setToken(null);
    check();
  }, [open, check]);

  const valid = REPO_NAME_RE.test(name.trim()) && ![".", ".."].includes(name.trim());
  const mount = freeMountName(projects, name.trim());

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const p = await backend.createGithubRepo({ name: name.trim(), private: priv, description, mountName: mount, setup });
      await loadProjects().catch(() => {});
      toast({ title: "Repository made", body: `${login ? `${login}/` : ""}${name.trim()}, added as a project`, tone: "success" });
      onCreated?.(p);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} width={500} title="New repo" subtitle="A new repository on GitHub, added as a project. It starts empty; each machine clones it when a wadspace opens it.">
      {token === false ? (
        <GithubTokenCallout missing="token" onRetry={check} />
      ) : (
        <div className="space-y-4">
          <div>
            <Label hint={login ? `on ${login}'s account` : undefined}>Name</Label>
            <Input autoFocus className="font-mono text-sm" placeholder="my-project" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && valid && !busy && create()} />
            {name.trim() && !valid && <p className="mt-1 text-xs text-accent-2">Letters, digits, dots, dashes and underscores.</p>}
          </div>
          <div>
            <Label hint="optional">Description</Label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div>
            <Label hint="optional · runs once in the wadspace">Setup command</Label>
            <Input className="font-mono text-xs" placeholder="e.g. npm install" value={setup} onChange={(e) => setSetup(e.target.value)} />
          </div>
          <label className="flex items-center gap-3 rounded-xl bg-surface-2 px-3 py-2.5 ring-1 ring-line">
            <Lock className="size-4 shrink-0 text-muted" />
            <span className="flex-1 text-sm">
              Private
              <span className="block text-xs text-muted">{priv ? "Only you (and people you invite on GitHub) see it." : "Anyone can see it."}</span>
            </span>
            <Toggle checked={priv} onChange={setPriv} label="Private" />
          </label>
          {valid && <p className="text-xs text-muted">Opens as <span className="font-mono">~/Desktop/{mount}</span>.</p>}
          {error && <p className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger ring-1 ring-danger/30">{error}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" onClick={create} disabled={!valid || busy || token === null}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />} Make it
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
