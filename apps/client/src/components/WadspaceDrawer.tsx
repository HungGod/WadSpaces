// A wadspace's details, from Step 1's picker and the Machines page: what it's
// built on and how its image stands, the folders it opens with (and had last
// time), where it runs, its run history, and what can be done with it: open
// it, customize it for a run, edit it in the Builder, start a new one from
// it, delete it.
import { useEffect, useState } from "react";
import { Copy, Layers, Lock, Pencil, Play, Server, SlidersHorizontal, Trash2, X } from "lucide-react";
import clsx from "clsx";
import { imageKey, resolve } from "@core/layers";
import { backend } from "@/data";
import { clockTime, timeAgo, uptime } from "@/lib/format";
import { isLocked, useApp } from "@/lib/store";
import { useUi } from "@/lib/ui";
import type { ContainerRun } from "@/lib/types";
import { useWadspaceActions } from "./manager/WadspaceActions";
import { RunHistory } from "./RunHistory";
import { Thumb } from "./Thumb";
import { Badge, Button, Drawer, IconButton } from "./ui";
import { BuildButton, ImageBadge } from "./wadbuilder/parts";

export function WadspaceDrawer() {
  const detailsId = useUi((s) => s.detailsId);
  const openDetails = useUi((s) => s.openDetails);
  const w = useApp((s) => s.wadspaces.find((x) => x.id === detailsId && !x.deletedAt));
  const close = () => openDetails(null);
  if (!w) return <Drawer open={false} onClose={close}>{null}</Drawer>;
  return <Details key={w.id} id={w.id} onClose={close} />;
}

function Details({ id, onClose }: { id: string; onClose: () => void }) {
  const w = useApp((s) => s.wadspaces.find((x) => x.id === id))!;
  const templates = useApp((s) => s.templates);
  const customizations = useApp((s) => s.customizations);
  const machines = useApp((s) => s.machines);
  const focus = useApp((s) => s.focus);
  const projects = useApp((s) => s.projects);
  const a = useWadspaceActions(w);
  /** Its most recent run, for the projects it had (runs record them). */
  const [lastRun, setLastRun] = useState<ContainerRun | null>(null);
  const caps = backend.caps;

  // Refreshed with the machine list, which changes as it starts and stops.
  useEffect(() => {
    let off = false;
    if (!caps.history || !caps.projects) return setLastRun(null);
    backend
      .runs({ wadspaceId: id })
      .then((r) => !off && setLastRun(r[0] ?? null))
      .catch(() => !off && setLastRun(null));
    return () => {
      off = true;
    };
  }, [id, machines, caps.history, caps.projects]);

  const r = resolve({ templates, customizations }, w.base);
  const locked = isLocked(focus, w.id);
  const running = machines.flatMap((m) => m.containers.filter((c) => c.wadspaceId === w.id).map((c) => ({ m, c })));
  const go = (fn: () => void) => () => {
    onClose();
    fn();
  };

  return (
    <Drawer open onClose={onClose}>
      <div className="relative shrink-0">
        <Thumb w={w} zoom={1.2} />
        <div className="absolute inset-0 bg-gradient-to-t from-surface via-surface/10 to-transparent" />
        <IconButton label="Close" onClick={onClose} className="absolute right-3 top-3 bg-black/40 text-white backdrop-blur-md hover:bg-black/60 hover:text-white">
          <X className="size-4" />
        </IconButton>
      </div>

      <div className="-mt-10 flex-1 space-y-7 overflow-y-auto px-6 pb-6">
        <section className="relative">
          <h2 className="font-display text-2xl font-bold tracking-tight">{w.name}</h2>
          {w.description && <p className="mt-1 text-sm text-muted">{w.description}</p>}
          <div className="mt-3 flex flex-wrap gap-1.5">
            <Badge>Updated {timeAgo(w.updatedAt)}</Badge>
            <Badge>
              <span className="font-mono">{w.id}</span>
            </Badge>
          </div>
        </section>

        <section className="grid grid-cols-2 gap-2">
          <Button variant="primary" disabled={locked} title={locked && focus ? `Locked until ${clockTime(focus.endsAt)}` : undefined} onClick={go(a.open)}>
            {locked ? <Lock className="size-4" /> : <Play className="size-4 fill-current" />} Open
          </Button>
          <Button disabled={locked} onClick={go(a.customize)} title="Its background, folders or secrets, for one run or as a new wadspace">
            <SlidersHorizontal className="size-4" /> Customize for a run
          </Button>
          <Button onClick={go(a.edit)}>
            <Pencil className="size-4" /> Edit in Builder
          </Button>
          <Button onClick={go(a.copy)}>
            <Copy className="size-4" /> New from it
          </Button>
        </section>

        <section>
          <SectionTitle>Built on</SectionTitle>
          <div className="flex items-center gap-3 rounded-2xl bg-surface-2 px-3 py-2.5 ring-1 ring-line">
            <Layers className="size-4 shrink-0 text-muted" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{r ? (r.customization ? `${r.customization.name} (${r.template.name})` : `${r.template.name} template`) : "Its template is gone"}</div>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                <ImageBadge image={imageKey(w.base)} />
                {w.legacyImage && <Badge tone="accent-2">Runs its image from before layers</Badge>}
              </div>
            </div>
            {r && <BuildButton image={imageKey(w.base)} />}
          </div>
        </section>

        {caps.projects && (
          <section>
            <SectionTitle>Project folders</SectionTitle>
            <div className="space-y-2.5 text-sm">
              <ProjectChips label="Opens with" ids={w.projects} none="No folders" names={projects} />
              {lastRun && <ProjectChips label={`Last run, ${timeAgo(lastRun.startedAt)}`} ids={lastRun.projects ?? []} none="No folders" names={projects} />}
            </div>
          </section>
        )}

        <section>
          <SectionTitle>Containers</SectionTitle>
          {running.length ? (
            <div className="space-y-2">
              {running.map(({ m, c }) => (
                <div key={c.id} className="flex items-center gap-3 rounded-2xl bg-surface-2 px-3 py-2.5 ring-1 ring-line">
                  <Server className="size-4 text-muted" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{m.label}</div>
                    <div className="text-xs text-muted">
                      {c.mode === "stream" ? "Streaming" : "On screen"} · {c.status === "running" ? `up ${uptime(c.startedAt)}` : "stopped"}
                    </div>
                  </div>
                  <span className={clsx("size-2 shrink-0 rounded-full", c.status === "running" ? "bg-accent shadow-[0_0_10px_var(--accent)]" : "bg-faint")} />
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted">Not on a machine yet: it's installed when it's first launched.</p>
          )}
        </section>

        {caps.history && (
          <section>
            <SectionTitle>Container history</SectionTitle>
            <div className="-mx-2">
              <RunHistory wadspaceId={w.id} limit={8} />
            </div>
          </section>
        )}

        <section className="pt-2">
          <Button variant="danger" className="w-full" onClick={a.remove}>
            <Trash2 className="size-4" /> Delete
          </Button>
        </section>
      </div>
    </Drawer>
  );
}

function ProjectChips({ label, ids, none, names }: { label: string; ids: string[]; none: string; names: { id: string; name: string }[] }) {
  return (
    <div>
      <div className="mb-1 text-xs text-muted">{label}</div>
      <div className="flex flex-wrap gap-1.5">{ids.length ? ids.map((id) => <Badge key={id}>{names.find((p) => p.id === id)?.name ?? "a deleted project"}</Badge>) : <span className="text-xs text-faint">{none}</span>}</div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">{children}</h3>;
}
