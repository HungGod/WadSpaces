// Secrets: what this machine keeps for its wadspaces to sign in with. Saved
// sign-ins (each mounted into the wadspaces and WadBrowser setups whose slots
// pick it) and the machine's tokens.
import { useEffect, useState } from "react";
import { Check, Cloud, KeyRound, LogOut, Pencil, Plus, Trash2, X } from "lucide-react";
import { Page } from "@/components/Page";
import { ConfirmSignIn, NewSignIn, SignInAppIcon, signInAppName } from "@/components/SignIns";
import { openMachinePanel } from "@/components/machine/panels";
import { Badge, Button, EmptyState, IconButton, Input, PageHeader } from "@/components/ui";
import { backend } from "@/data";
import { keyUse, wadspaceName, type KeyUser } from "@/data/layers";
import { Thumb } from "@/components/Thumb";
import { noIcon } from "@/lib/webIcon";
import clsx from "clsx";
import { timeAgo } from "@/lib/format";
import { hasLocal } from "@/lib/machine";
import { useApp } from "@/lib/store";
import { formatBytes, type WaddSecret, type WaddSignIn } from "@/lib/wadd";

const ORIGIN: Record<WaddSecret["origin"], string> = {
  account: "From your account",
  local: "Set on this machine",
  placeholder: "Not set",
};

/** Everything this machine keeps for its wadspaces to sign in with: saved
 *  sign-ins (mounted into the wadspaces whose apps use them) and tokens. */
export default function SecretsPage() {
  const signIns = useApp((s) => s.signIns);
  const wadspaces = useApp((s) => s.wadspaces);
  const browsers = useApp((s) => s.browsers);
  const toast = useApp((s) => s.toast);
  const loadSignIns = useApp((s) => s.loadSignIns);
  const [making, setMaking] = useState(false);
  const [confirm, setConfirm] = useState<{ signIn: WaddSignIn; action: "signout" | "delete" } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [secrets, setSecrets] = useState<WaddSecret[]>([]);

  useEffect(() => {
    loadSignIns().catch(() => {});
    backend.listSecrets().then(setSecrets, () => setSecrets([]));
  }, [loadSignIns]);

  const name = (wsId: string) => {
    const w = wadspaces.find((x) => x.id === wsId);
    return w ? wadspaceName(w) : wsId;
  };
  const templates = useApp((s) => s.templates);
  const extensions = useApp((s) => s.extensions);
  const use = keyUse({ templates, extensions, wadspaces, browsers });

  const rename = async (s: WaddSignIn) => {
    const n = newName.trim();
    setRenaming(null);
    if (!n || n === s.name) return;
    try {
      await useApp.getState().renameSignIn(s.id, n);
    } catch (e) {
      toast({ title: "Couldn't rename it", body: (e as Error).message, tone: "error" });
    }
  };

  return (
    <Page>
      <PageHeader
        title="Secrets"
        subtitle="What your wadspaces sign in with. A saved sign-in is mounted into every wadspace whose apps use it: sign in once, in any of them, and the rest are signed in too."
      >
        {backend.caps.signins && (
          <Button variant="primary" onClick={() => setMaking(true)}>
            <Plus className="size-4" /> New sign-in
          </Button>
        )}
      </PageHeader>

      {!hasLocal ? (
        <EmptyState
          icon={<Cloud className="size-6" />}
          title="On your machines"
          body="Saved sign-ins never leave the machine they're on. Open WadSpaces on a machine to see and manage its sign-ins."
        />
      ) : !backend.caps.signins ? (
        <EmptyState icon={<KeyRound className="size-6" />} title="Not on this machine yet" body="This machine's wadd predates saved sign-ins. Update the system (a stick update) to use them." />
      ) : (
        <>
          <h2 className="mb-3 font-display text-base font-semibold">Saved sign-ins</h2>
          {!signIns.length ? (
            <EmptyState
              icon={<KeyRound className="size-6" />}
              title="No saved sign-ins yet"
              body="Construct a wadspace in the Builder and its apps' sign-ins are saved here (or make one now). Then sign in once in any wadspace that uses it."
              action={
                <Button variant="primary" onClick={() => setMaking(true)}>
                  <Plus className="size-4" /> New sign-in
                </Button>
              }
            />
          ) : (
            <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
              {signIns.map((s) => {
                // One row per wadspace (or WadBrowser setup), with every app the key signs in there.
                const users = Object.values(
                  (use[s.id] ?? []).reduce<Record<string, KeyUser>>((by, u) => {
                    const k = `${u.kind}/${u.id}`;
                    by[k] = by[k] ? { ...by[k], what: `${by[k].what}, ${u.what}`, items: [...by[k].items, ...u.items] } : u;
                    return by;
                  }, {}),
                );
                // Installed here but not (or no longer) in a wadspace you have.
                const others = s.usedBy.filter((id) => !users.some((u) => u.id === id || `browser-${u.id}` === id));
                return (
                  <div key={s.id} className="flex flex-col rounded-2xl border border-line bg-surface/70 p-4 transition-colors hover:border-line-strong">
                    <div className="flex items-start gap-3">
                      <KeyIcon items={users.flatMap((u) => u.items)} app={s.app} />
                      <div className="min-w-0 flex-1">
                        {renaming === s.id ? (
                          <form
                            className="flex items-center gap-1"
                            onSubmit={(e) => {
                              e.preventDefault();
                              rename(s);
                            }}
                          >
                            <Input value={newName} onChange={(e) => setNewName(e.target.value)} autoFocus className="h-8 py-1 text-sm" />
                            <IconButton label="Save" type="submit">
                              <Check className="size-4" />
                            </IconButton>
                            <IconButton label="Cancel" type="button" onClick={() => setRenaming(null)}>
                              <X className="size-4" />
                            </IconButton>
                          </form>
                        ) : (
                          <div className="truncate font-display text-[15px] font-semibold">{s.name}</div>
                        )}
                        <div className="truncate text-xs text-muted">{signInAppName(s.app)}</div>
                      </div>
                      {renaming !== s.id && (
                        <IconButton
                          label="Rename"
                          onClick={() => {
                            setNewName(s.name);
                            setRenaming(s.id);
                          }}
                        >
                          <Pencil className="size-4" />
                        </IconButton>
                      )}
                      <IconButton label="Sign out everywhere" onClick={() => setConfirm({ signIn: s, action: "signout" })} disabled={!s.size}>
                        <LogOut className="size-4" />
                      </IconButton>
                      <IconButton label="Delete" onClick={() => setConfirm({ signIn: s, action: "delete" })}>
                        <Trash2 className="size-4" />
                      </IconButton>
                    </div>
                    <div className="mt-3 space-y-1 text-xs text-muted">
                      <div>{s.size ? `${formatBytes(s.size)} saved${s.changedAt ? `, changed ${timeAgo(s.changedAt)}` : ""}` : "Not signed in yet"}</div>
                      {s.paths.length > 0 && (
                        <div className="truncate font-mono" title={s.paths.map((p) => `~/${p}`).join("\n")}>
                          {s.paths.map((p) => `~/${p}`).join(", ")}
                        </div>
                      )}
                    </div>
                    <UsedIn users={users} running={s.inUse} />
                    {(others.length > 0 || !users.length) && (
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {others.map((id) => (
                          <Badge key={id}>{name(id)}</Badge>
                        ))}
                        {!users.length && !others.length && <Badge>Not used by a wadspace</Badge>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {secrets.length > 0 && (
            <>
              <h2 className="mb-3 mt-10 font-display text-base font-semibold">Tokens</h2>
              <p className="mb-3 text-sm text-muted">Kept on this machine for its wadspaces (github_token lets git reach your repositories). Their values never reach this page.</p>
              <div className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface/70">
                {secrets.map((t) => (
                  <div key={t.name} className="flex items-center gap-3 px-4 py-3">
                    <KeyRound className="size-4 shrink-0 text-muted" />
                    <span className="min-w-0 flex-1 truncate font-mono text-sm">{t.name}</span>
                    <Badge tone={t.origin === "placeholder" ? "default" : "accent"}>{ORIGIN[t.origin]}</Badge>
                    {t.name === "github_token" && backend.target === "machine" && (
                      <Button size="sm" variant="ghost" onClick={() => openMachinePanel("github")}>
                        GitHub sign-in
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}

      <NewSignIn open={making} onClose={() => setMaking(false)} />
      <ConfirmSignIn signIn={confirm?.signIn ?? null} action={confirm?.action ?? "signout"} onClose={() => setConfirm(null)} />
    </Page>
  );
}

/** What a key signs in: that app's icon, or (signing in several) a folder of theirs, as on a phone. */
function KeyIcon({ items, app }: { items: KeyUser["items"]; app: string }) {
  const icons = [...new Map(items.map((i) => [i.icon, i])).values()];
  if (!icons.length)
    return (
      <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent">
        <SignInAppIcon app={app} />
      </span>
    );
  if (icons.length === 1)
    return (
      <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-surface-2 ring-1 ring-line" title={icons[0].name}>
        <img src={icons[0].icon} onError={noIcon} alt="" className="size-7 object-contain" />
      </span>
    );
  // A folder: up to four of them, and how many more.
  return (
    <span className="grid size-11 shrink-0 grid-cols-2 gap-0.5 rounded-xl bg-surface-3 p-1.5 ring-1 ring-line" title={icons.map((i) => i.name).join(", ")}>
      {icons.slice(0, icons.length > 4 ? 3 : 4).map((i) => (
        <img key={i.icon} src={i.icon} onError={noIcon} alt="" className="size-full object-contain" />
      ))}
      {icons.length > 4 && <span className="grid place-items-center rounded bg-surface-2 text-[8px] font-bold text-muted">+{icons.length - 3}</span>}
    </span>
  );
}

/** The wadspaces (and WadBrowser setups) a key is attached to, each wired to the apps it signs in there. */
function UsedIn({ users, running }: { users: KeyUser[]; running: string[] }) {
  const wadspaces = useApp((s) => s.wadspaces);
  if (!users.length) return null;
  return (
    <div className="mt-3 space-y-1.5">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-faint">Used in</div>
      {users.map((u) => {
        const w = u.kind === "wadspace" ? wadspaces.find((x) => x.id === u.id) : undefined;
        const live = running.includes(u.id) || running.includes(`browser-${u.id}`);
        return (
          <div key={`${u.kind}/${u.id}/${u.what}`} className="flex items-center gap-2" title={`${u.name}: ${u.what}${live ? " (in use now)" : ""}`}>
            {w ? (
              <Thumb w={w} zoom={6} className="!w-12 shrink-0 rounded-md ring-1 ring-line" />
            ) : (
              <span className="grid aspect-video w-12 shrink-0 place-items-center rounded-md bg-surface-2 ring-1 ring-line">
                <img src="/brand/wadbrowser-icon-dark.svg" alt="" className="size-4" />
              </span>
            )}
            <span className="min-w-0 max-w-[40%] truncate text-xs font-medium">{u.name}</span>
            {live && <span className="size-1.5 shrink-0 rounded-full bg-accent shadow-[0_0_6px_var(--accent)]" aria-label="In use now" />}
            {/* The wire, from the wadspace to what the key signs in there. */}
            <span className={clsx("h-0.5 min-w-4 flex-1 rounded-full", live ? "bg-accent/70" : "bg-[var(--layer-customization)]/40")} />
            <span className="flex shrink-0 items-center gap-1 rounded-lg bg-surface-2 px-1.5 py-1 ring-1 ring-line">
              {u.items.slice(0, 5).map((i) => (
                <img key={i.name} src={i.icon} onError={noIcon} alt={i.name} title={i.name} className="size-4 object-contain" />
              ))}
              {u.items.length > 5 && <span className="text-[10px] text-muted">+{u.items.length - 5}</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
}
