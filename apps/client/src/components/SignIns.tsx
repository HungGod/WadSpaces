import { useEffect, useMemo, useState } from "react";
import { Globe, Loader2, LogOut, Trash2 } from "lucide-react";
import catalog from "@core-data/apps.json";
import { localIcon } from "@core/catalog/icons";
import { WEB, isSignInPath, signInKind, signInPaths } from "@core/signins";
import { backend } from "@/data";
import { useApp } from "@/lib/store";
import type { LayoutIcon, Wadspace } from "@/lib/types";
import type { WaddSignIn } from "@/lib/wadd";
import { Button, Input, Label, Modal, Textarea } from "./ui";

type CatalogApp = { id: string; name: string; iconUrl: string };
const APPS = catalog as CatalogApp[];

/** Apps whose sign-in files WadSpaces knows that aren't in the catalog yet. */
const KNOWN_NAMES: Record<string, string> = { cursor: "Cursor" };

/** What a sign-in is for: "Web apps", or the app's name. */
export function signInAppName(app: string): string {
  if (app === WEB) return "Web apps";
  return APPS.find((a) => a.id === app)?.name ?? KNOWN_NAMES[app] ?? app;
}

export function SignInAppIcon({ app, className = "size-5" }: { app: string; className?: string }) {
  const a = APPS.find((x) => x.id === app);
  if (app === WEB || !a) return <Globe className={className} />;
  return <img src={localIcon(a.iconUrl)} alt="" className={className + " rounded"} />;
}

/** The saved sign-ins an icon's app can use: web ones for a web app, its
 *  own app's otherwise. */
export function fitting(signIns: WaddSignIn[], icon: Pick<LayoutIcon, "appId" | "url" | "iconUrl">): WaddSignIn[] {
  const kind = signInKind(icon);
  return kind ? signIns.filter((s) => s.app === kind) : [];
}

/** Which designs give it to which of their apps: "IQ · GitHub". */
export function usersOf(id: string, wadspaces: Wadspace[]): { ws: Wadspace; label: string }[] {
  return wadspaces.flatMap((ws) => ws.layout.icons.filter((i) => i.signIn === id).map((i) => ({ ws, label: i.label })));
}

/** Paths typed one per line, ~/ allowed. */
function parsePaths(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim().replace(/^~\//, ""))
    .filter(Boolean);
}

/** A new saved sign-in: for web apps, or for an app (its files are known, or
 *  you name them). `app` fixes what it's for (the Builder knows). */
export function NewSignIn({
  open,
  app: fixedApp,
  defaultName = "",
  onClose,
  onMade,
}: {
  open: boolean;
  app?: string;
  defaultName?: string;
  onClose: () => void;
  onMade?: (s: WaddSignIn) => void;
}) {
  const toast = useApp((s) => s.toast);
  const loadSignIns = useApp((s) => s.loadSignIns);
  const [name, setName] = useState(defaultName);
  const [app, setApp] = useState(fixedApp ?? WEB);
  const [paths, setPaths] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Installable apps a sign-in can be for: known files first.
  const choices = useMemo(() => {
    const apps = APPS.filter((a) => signInKind({ appId: a.id, iconUrl: a.iconUrl }) === a.id);
    const known = apps.filter((a) => signInPaths(a.id));
    const other = apps.filter((a) => !signInPaths(a.id));
    return [...known, ...other];
  }, []);

  useEffect(() => {
    if (!open) return;
    setName(defaultName);
    setApp(fixedApp ?? WEB);
    setPaths("");
    setError(null);
  }, [open, defaultName, fixedApp]);

  const known = app === WEB ? [] : signInPaths(app);
  const typed = parsePaths(paths);
  const badPath = typed.find((p) => !isSignInPath(p));
  const ready = name.trim() && (app === WEB || known || (typed.length && !badPath));

  const make = async () => {
    setBusy(true);
    setError(null);
    try {
      const s = await backend.createSignIn({ name: name.trim(), app, ...(!known && app !== WEB && { paths: typed }) });
      await loadSignIns().catch(() => {});
      toast({ title: "Sign-in saved", body: `${s.name}: sign in once, in any wadspace that uses it.` });
      onMade?.(s);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} width={500} title="New saved sign-in" subtitle="Kept on this machine and shared by every wadspace whose apps use it.">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) make();
        }}
      >
        <div>
          <Label>Name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Work GitHub" autoFocus />
        </div>
        {!fixedApp && (
          <div>
            <Label hint="A web sign-in works for any web app; an app's, for that app.">For</Label>
            <select
              value={app}
              onChange={(e) => setApp(e.target.value)}
              className="w-full rounded-xl bg-surface-2 px-3 py-2 text-sm ring-1 ring-line outline-none focus:ring-accent"
            >
              <option value={WEB}>Web apps (WadBrowser)</option>
              {choices.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
        )}
        {app !== WEB && known && (
          <p className="text-xs text-muted">
            Keeps {signInAppName(app)}'s sign-in: <span className="font-mono">{known.map((p) => `~/${p}`).join(", ")}</span>
          </p>
        )}
        {app !== WEB && !known && (
          <div>
            <Label hint="Under the home folder, one per line; end a folder with /.">Which files hold its sign-in?</Label>
            <Textarea value={paths} onChange={(e) => setPaths(e.target.value)} rows={3} placeholder={".config/app/\n.app-token.json"} className="font-mono text-xs" />
            {badPath && <p className="mt-1 text-xs text-danger">{badPath}: a path under the home folder (not the Desktop)</p>}
          </div>
        )}
        {error && <p className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger ring-1 ring-danger/30">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!ready || busy}>
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
              : "It's forgotten, with what it saved. Give its apps another sign-in in the Builder first."}
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
