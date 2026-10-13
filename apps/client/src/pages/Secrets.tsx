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
import { keyUse, wadspaceName } from "@/data/layers";
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
                const users = use[s.id] ?? [];
                // Installed here but not (or no longer) in a wadspace you have.
                const others = s.usedBy.filter((id) => !users.some((u) => u.id === id || `browser-${u.id}` === id));
                return (
                  <div key={s.id} className="flex flex-col rounded-2xl border border-line bg-surface/70 p-4 transition-colors hover:border-line-strong">
                    <div className="flex items-start gap-3">
                      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent">
                        <SignInAppIcon app={s.app} />
                      </span>
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
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {s.inUse.map((id) => (
                        <Badge key={id} tone="accent">
                          In use in {name(id)}
                        </Badge>
                      ))}
                      {users.map((u) => (
                        <Badge key={`${u.kind}/${u.id}/${u.what}`} tone="accent-2">
                          {u.name} · {u.what}
                        </Badge>
                      ))}
                      {others.map((id) => (
                        <Badge key={id}>{name(id)}</Badge>
                      ))}
                      {!users.length && !others.length && <Badge>Not used by a wadspace</Badge>}
                    </div>
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
