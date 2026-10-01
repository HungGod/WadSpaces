import { Link } from "react-router";
import { useEffect, useState } from "react";
import { Check, FolderGit2, HardDrive, Lock, Pencil, Play, Server, Timer, Trash2, Users, X } from "lucide-react";
import clsx from "clsx";
import { backend } from "@/data";
import { clockTime, size, timeAgo, uptime } from "@/lib/format";
import { openWadspace, opensByLaunch, transfer } from "@/lib/launch";
import { RunHistory } from "./RunHistory";
import { StreamLink } from "./Tailnet";
import { isLocked, useApp } from "@/lib/store";
import { useUi } from "@/lib/ui";
import type { ContainerRun, Visibility } from "@/lib/types";
import { Thumb } from "./Thumb";
import { Avatar, Badge, Button, Drawer, IconButton, Input, Label, Segmented, Textarea } from "./ui";

export function WadspaceDrawer() {
  const detailsId = useUi((s) => s.detailsId);
  const openDetails = useUi((s) => s.openDetails);
  const openFocus = useUi((s) => s.openFocus);
  const ws = useApp((s) => s.wadspaces.find((w) => w.id === detailsId));
  const user = useApp((s) => s.user);
  const users = useApp((s) => s.users);
  const machines = useApp((s) => s.machines);
  const launchTarget = useApp((s) => s.launchTarget);
  const focus = useApp((s) => s.focus);
  const patchWadspace = useApp((s) => s.patchWadspace);
  const loadWadspaces = useApp((s) => s.loadWadspaces);
  const toast = useApp((s) => s.toast);
  const download = useApp((s) => s.downloads.find((d) => d.wadspaceId === detailsId));
  const projects = useApp((s) => s.projects);
  const openRun = useUi((s) => s.openRun);
  /** Its most recent run, for the projects it had (runs record them). */
  const [lastRun, setLastRun] = useState<ContainerRun | null>(null);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (ws) {
      setName(ws.name);
      setDescription(ws.description);
    }
    // Only reset the form when a different wadspace opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws?.id]);

  // Refreshed with the machine list, which changes as it starts and stops.
  useEffect(() => {
    let off = false;
    if (!detailsId || !backend.caps.history || !backend.caps.projects) return setLastRun(null);
    backend
      .runs({ wadspaceId: detailsId })
      .then((r) => !off && setLastRun(r[0] ?? null))
      .catch(() => !off && setLastRun(null));
    return () => {
      off = true;
    };
  }, [detailsId, machines]);

  const close = () => openDetails(null);
  const caps = backend.caps;
  if (!ws) return <Drawer open={false} onClose={close}>{null}</Drawer>;

  const mine = ws.owner === user?.username;
  const owner = users.find((u) => u.username === ws.owner);
  const dirty = name !== ws.name || description !== ws.description;
  const locked = isLocked(focus, ws.id);
  const running = machines.flatMap((m) => m.containers.filter((c) => c.wadspaceId === ws.id).map((c) => ({ m, c })));
  const others = users.filter((u) => u.username !== user?.username);

  const save = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await patchWadspace(ws.id, { name: name.trim(), description: description.trim() });
      toast({ title: "Saved", body: name.trim(), tone: "success" });
    } finally {
      setSaving(false);
    }
  };

  const setVisibility = (visibility: Visibility) => patchWadspace(ws.id, { visibility });
  const toggleShare = (u: string) =>
    patchWadspace(ws.id, { sharedWith: ws.sharedWith.includes(u) ? ws.sharedWith.filter((x) => x !== u) : [...ws.sharedWith, u] });

  const remove = async () => {
    if (!confirm(`Delete "${ws.name}"?${backend.target === "offline" ? " This removes it from this machine." : ""}`)) return;
    try {
      await backend.deleteWadspace(ws.id);
    } catch (e) {
      toast({ title: "Couldn't delete", body: (e as Error).message, tone: "error" });
      return;
    }
    close();
    loadWadspaces();
  };

  return (
    <Drawer open onClose={close}>
      <div className="relative shrink-0">
        <Thumb ws={ws} />
        <div className="absolute inset-0 bg-gradient-to-t from-surface via-surface/10 to-transparent" />
        <IconButton label="Close" onClick={close} className="absolute right-3 top-3 bg-black/40 text-white backdrop-blur-md hover:bg-black/60 hover:text-white">
          <X className="size-4" />
        </IconButton>
      </div>

      <div className="-mt-10 flex-1 space-y-7 overflow-y-auto px-6 pb-6">
        {/* Identity */}
        <section className="relative">
          {mine ? (
            <div className="space-y-3">
              <div>
                <Label hint={<span className="flex items-center gap-1"><Pencil className="size-3" /> editable</span>}>Name</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} className="h-11 font-display text-lg font-semibold" />
              </div>
              <div>
                <Label>Description</Label>
                <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What's this wadspace for?" />
              </div>
              {dirty && (
                <div className="flex justify-end gap-2">
                  <Button size="sm" variant="ghost" onClick={() => { setName(ws.name); setDescription(ws.description); }}>Reset</Button>
                  <Button size="sm" variant="primary" onClick={save} disabled={saving || !name.trim()}>
                    <Check className="size-3.5" /> Save changes
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <div>
              <h2 className="font-display text-2xl font-bold tracking-tight">{ws.name}</h2>
              <p className="mt-1 text-sm text-muted">{ws.description}</p>
              {owner && (
                <div className="mt-3 flex items-center gap-2 text-sm text-muted">
                  <Avatar user={owner} size={22} className="ring-0" /> Owned by <b className="text-fg">{owner.displayName}</b>
                </div>
              )}
            </div>
          )}
          <div className="mt-3 flex flex-wrap gap-1.5">
            <Badge>{size(ws.sizeMB)}</Badge>
            <Badge>Updated {timeAgo(ws.updatedAt)}</Badge>
            <Badge>{ws.layout.icons.length} apps</Badge>
            <Badge>
              <span className="font-mono">{ws.id.slice(0, 8)}</span>
            </Badge>
          </div>
        </section>

        {/* Actions */}
        <section className="grid grid-cols-2 gap-2">
          <Button variant="primary" disabled={locked} title={locked && focus ? `Locked until ${clockTime(focus.endsAt)}` : undefined} onClick={() => openWadspace(ws)}>
            {locked ? <Lock className="size-4" /> : <Play className="size-4 fill-current" />} Open
          </Button>
          <Button disabled={!!focus} onClick={() => openFocus([ws.id])}>
            <Timer className="size-4" /> Focus
          </Button>
          {ws.machineOnly ? (
            <p className="col-span-2 rounded-xl bg-surface-2 px-3 py-2 text-xs text-muted ring-1 ring-line">
              Built on {ws.machineOnly}. Edit it there, in Wad Creator on that machine.
            </p>
          ) : (
            <Link to={mine ? `/builder/${ws.id}` : `/builder/${ws.id}?duplicate=1`} onClick={close} className="col-span-2">
              <Button className="w-full">
                <Pencil className="size-4" /> {mine ? "Edit in Builder" : "Duplicate in Builder"}
              </Button>
            </Link>
          )}
        </section>

        {/* Projects */}
        {caps.projects && (
          <section>
            <SectionTitle>Projects</SectionTitle>
            <div className="space-y-2.5 text-sm">
              <ProjectChips label="Opens with" ids={ws.advanced.projects ?? []} none="No default projects" names={projects} />
              {lastRun && (
                <ProjectChips label={`Last run, ${timeAgo(lastRun.startedAt)}`} ids={lastRun.projects ?? []} none="No projects" names={projects} />
              )}
            </div>
            {/* Online it says when that arrives (trusted machines). */}
            {(opensByLaunch(ws) || backend.target === "online") && (
              <Button size="sm" className="mt-3" disabled={locked} onClick={() => openRun(ws.id)}>
                <FolderGit2 className="size-3.5" /> Open with other projects…
              </Button>
            )}
          </section>
        )}

        {/* Visibility */}
        {mine && caps.sharing && (
          <section>
            <SectionTitle>Visibility</SectionTitle>
            <Segmented
              value={ws.visibility}
              onChange={setVisibility}
              className="w-full"
              options={[
                { value: "private", label: <><Lock className="size-3.5" /> Private</> },
                { value: "shared", label: <><Users className="size-3.5" /> Shared</> },
              ]}
            />
            <p className="mt-2 text-xs text-muted">
              {ws.visibility === "private" && "Only you can see and open this wadspace."}
              {ws.visibility === "shared" && "Only the people you pick can see and open it."}
            </p>
            {ws.visibility === "shared" && (
              <div className="mt-3 flex flex-wrap gap-2">
                {others.map((u) => {
                  const on = ws.sharedWith.includes(u.username);
                  return (
                    <button
                      key={u.username}
                      type="button"
                      onClick={() => toggleShare(u.username)}
                      className={clsx("flex items-center gap-2 rounded-full py-1 pl-1 pr-3 text-sm ring-1 transition-colors", on ? "bg-accent-soft ring-accent" : "bg-surface-2 ring-line hover:ring-line-strong")}
                    >
                      <Avatar user={u} size={24} className="ring-0" /> {u.displayName}
                      {on && <Check className="size-3.5 text-accent" />}
                    </button>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {/* Storage */}
        <section>
          <SectionTitle>Storage</SectionTitle>
          <div className="divide-y divide-line overflow-hidden rounded-2xl ring-1 ring-line">
            <StorageRow
              icon={<HardDrive className="size-4" />}
              title={backend.target === "offline" ? "This machine" : (machines.find((m) => m.id === launchTarget)?.label ?? "Your machine")}
              status={!ws.installed ? `Not built ${backend.target === "offline" ? "here" : "there"} yet` : ws.local ? "Ready" : download ? `Downloading · ${Math.floor(download.progress * 100)}%` : "Image not downloaded"}
              on={ws.local}
              action={
                backend.target === "offline" && ws.installed && !ws.local && !download ? (
                  <Button size="sm" onClick={() => transfer(ws, "pull")}>
                    Download
                  </Button>
                ) : null
              }
            />
          </div>
        </section>

        {/* Containers */}
        <section>
          <SectionTitle>Containers</SectionTitle>
          {running.length ? (
            <div className="space-y-2">
              {running.map(({ m, c }) => (
                <div key={c.id} className="flex items-center gap-3 rounded-2xl bg-surface-2 px-3 py-2.5 ring-1 ring-line">
                  <Server className="size-4 text-muted" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{m.label}</div>
                    <div className="text-xs text-muted">{c.mode === "stream" ? "Streaming" : "Local session"} · {c.status === "running" ? `up ${uptime(c.startedAt)}` : "stopped"}</div>
                    {c.status === "running" && c.streamUrl && <StreamLink url={c.streamUrl} className="mt-1.5" />}
                  </div>
                  <span className={clsx("size-2 shrink-0 rounded-full", c.status === "running" ? "bg-accent shadow-[0_0_10px_var(--accent)]" : "bg-faint")} />
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted">Not running anywhere.</p>
          )}
        </section>

        {/* History */}
        {caps.history && <section>
          <SectionTitle>Container history</SectionTitle>
          <div className="-mx-2">
            <RunHistory wadspaceId={ws.id} limit={8} />
          </div>
        </section>}

        {mine && (
          <section className="pt-2">
            <Button variant="danger" className="w-full" onClick={remove}>
              <Trash2 className="size-4" /> Delete wadspace
            </Button>
          </section>
        )}
      </div>
    </Drawer>
  );
}

function ProjectChips({ label, ids, none, names }: { label: string; ids: string[]; none: string; names: { id: string; name: string }[] }) {
  return (
    <div>
      <div className="mb-1 text-xs text-muted">{label}</div>
      <div className="flex flex-wrap gap-1.5">
        {ids.length ? (
          ids.map((id) => <Badge key={id}>{names.find((p) => p.id === id)?.name ?? "a deleted project"}</Badge>)
        ) : (
          <span className="text-xs text-faint">{none}</span>
        )}
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">{children}</h3>;
}

function StorageRow({ icon, title, status, on, action }: { icon: React.ReactNode; title: string; status: string; on: boolean; action: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 bg-surface-2/50 px-3.5 py-3">
      <span className={clsx("grid size-8 place-items-center rounded-xl", on ? "bg-accent-soft text-fg dark:text-accent" : "bg-surface-3 text-faint")}>{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{title}</div>
        <div className="text-xs text-muted">{status}</div>
      </div>
      {action}
    </div>
  );
}
