// Saved sign-ins: what each kind is called and looks like, making a new
// one, and signing out of or deleting one. The Secrets page lists them; the
// Builder's Step 3 makes them as it saves a wadspace.
import { useEffect, useState } from "react";
import { Globe, Loader2, LogOut, Trash2 } from "lucide-react";
import catalog from "@core-data/apps.json";
import { appById, SECRET_KINDS } from "@core/catalog/catalog";
import { signInKinds, type SecretKind } from "@core/layers";
import { WEB, signInPaths } from "@core/signins";
import { backend } from "@/data";
import { useApp } from "@/lib/store";
import type { WaddSignIn } from "@/lib/wadd";
import { Button, Input, Label, Modal } from "./ui";

type CatalogApp = { id: string; name: string };
/** Apps sign-ins from before the kinds were for. */
const OLD_APPS = catalog as CatalogApp[];

/** Each kind's picture: the app (or extension) it's for. */
const KIND_ICON: Record<string, string> = {
  obsidian: appById("obsidian")?.icon ?? "",
  steam: appById("steam")?.icon ?? "",
  "vscode-claude-code": "/catalog/claude.png",
  "vscode-codex": "/catalog/codex.png",
};

/** What a sign-in is for: its kind ("WadBrowser sign-in"), or the app an older one was made for. */
export function signInAppName(app: string): string {
  return SECRET_KINDS[app as SecretKind]?.label ?? OLD_APPS.find((a) => a.id === app)?.name ?? app;
}

export function SignInAppIcon({ app, className = "size-5" }: { app: string; className?: string }) {
  const src = KIND_ICON[app];
  if (app === WEB || !src) return <Globe className={className} />;
  return <img src={src} alt="" className={className + " rounded object-contain"} />;
}

/** A new saved sign-in of a kind: kept on this machine, mounted into the
 *  wadspaces (and WadBrowser setups) whose slots pick it. */
export function NewSignIn({ open, onClose, onMade }: { open: boolean; onClose: () => void; onMade?: (s: WaddSignIn) => void }) {
  const toast = useApp((s) => s.toast);
  const loadSignIns = useApp((s) => s.loadSignIns);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<SecretKind>("web");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName("");
    setKind("web");
    setError(null);
  }, [open]);

  const files = kind === "web" ? [] : (signInPaths(kind) ?? []);
  const make = async () => {
    setBusy(true);
    setError(null);
    try {
      const s = await backend.createSignIn({ name: name.trim(), app: kind });
      await loadSignIns().catch(() => {});
      toast({ title: "Sign-in saved", body: `${s.name}: pick it for a wadspace's slot in the Builder, then sign in once.` });
      onMade?.(s);
      onClose();
    } catch (e) {
      // 409: the name is taken.
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} width={500} title="New saved sign-in" subtitle="Kept on this machine and shared by every wadspace that picks it.">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) void make();
        }}
      >
        <div>
          <Label>Name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Work GitHub" autoFocus />
        </div>
        <div>
          <Label hint="Only a slot of the same kind can use it.">Kind</Label>
          <select value={kind} onChange={(e) => setKind(e.target.value as SecretKind)} className="w-full rounded-xl bg-surface-2 px-3 py-2 text-sm ring-1 ring-line outline-none focus:ring-accent">
            {signInKinds().map((k) => (
              <option key={k} value={k}>
                {SECRET_KINDS[k].label}
              </option>
            ))}
          </select>
          <p className="mt-1.5 text-xs text-muted">
            {SECRET_KINDS[kind].keeps}
            {files.length > 0 && (
              <>
                : <span className="font-mono">{files.map((p) => `~/${p}`).join(", ")}</span>
              </>
            )}
          </p>
        </div>
        {error && <p className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger ring-1 ring-danger/30">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!name.trim() || busy}>
            {busy && <Loader2 className="size-4 animate-spin" />} Save sign-in
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Sign out everywhere (keeps it) or delete it: both refused while it's in use. */
export function ConfirmSignIn({ signIn: s, action, onClose }: { signIn: WaddSignIn | null; action: "signout" | "delete"; onClose: () => void }) {
  const toast = useApp((st) => st.toast);
  const loadSignIns = useApp((st) => st.loadSignIns);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setError(null), [s?.id, action]);

  const go = async () => {
    if (!s) return;
    setBusy(true);
    setError(null);
    try {
      if (action === "signout") await backend.signOutSignIn(s.id);
      else await backend.deleteSignIn(s.id);
      await loadSignIns().catch(() => {});
      toast({ title: action === "signout" ? "Signed out" : "Sign-in deleted", body: s.name });
      onClose();
    } catch (e) {
      // 409: a wadspace is running with it, or (delete) still uses it.
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const signout = action === "signout";
  return (
    <Modal open={!!s} onClose={onClose} width={460} title={s && (signout ? `Sign out of ${s.name}?` : `Delete ${s.name}?`)}>
      {s && (
        <div className="space-y-4">
          <p className="text-sm text-muted">
            {signout
              ? "What it saved (cookies, tokens) is forgotten, so every wadspace using it is signed out. It stays, for signing in again."
              : "It's forgotten, with what it saved. Pick another for the wadspaces using it in the Builder first."}
          </p>
          {error && <p className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger ring-1 ring-danger/30">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="danger" onClick={go} disabled={busy}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : signout ? <LogOut className="size-4" /> : <Trash2 className="size-4" />}{" "}
              {signout ? "Sign out everywhere" : "Delete sign-in"}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
