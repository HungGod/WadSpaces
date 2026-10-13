// A wadspace's details, from Home and the Machines page: what it's built on
// (its templates, bottom first, and Extensions) and how its image stands, its
// projects, where it runs, its run history, and what can be done with it:
// open it, customize it for a run, edit it on the board, copy it there,
// delete it.
import { Copy, FolderGit2, HardDriveDownload, Layers, Lock, Pencil, Play, Server, SlidersHorizontal, Trash2, X } from "lucide-react";
import clsx from "clsx";
import { resolveStack } from "@core/layers";
import { backend } from "@/data";
import { layerOf, wadspaceName } from "@/data/layers";
import { clockTime, timeAgo, uptime } from "@/lib/format";
import { isLocked, useApp } from "@/lib/store";
import { useUi } from "@/lib/ui";
import { useWadspaceActions } from "./manager/WadspaceActions";
import { RunHistory } from "./RunHistory";
import { Thumb } from "./Thumb";
import { Badge, Button, Drawer, IconButton } from "./ui";
import { BuildButton, ImageBadge } from "./launcher/parts";

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
  const extensions = useApp((s) => s.extensions);
  const machines = useApp((s) => s.machines);
  const focus = useApp((s) => s.focus);
  const a = useWadspaceActions(w);
  const caps = backend.caps;
  const r = resolveStack({ templates, extensions }, w);
  const image = layerOf(w);
  const projects = w.customization?.projects ?? [];
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
          <h2 className="font-display text-2xl font-bold tracking-tight">{wadspaceName(w)}</h2>
          {w.customization?.description && <p className="mt-1 text-sm text-muted">{w.customization.description}</p>}
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
          <Button disabled={locked} onClick={go(a.customize)} title="Its background or keys, for one run or as a new wadspace">
            <SlidersHorizontal className="size-4" /> Customize for a run
          </Button>
          <Button onClick={go(a.edit)}>
            <Pencil className="size-4" /> Edit on the board
          </Button>
          <Button onClick={go(a.copy)}>
            <Copy className="size-4" /> Copy it
          </Button>
        </section>

        <section>
          <SectionTitle>Built on</SectionTitle>
          <div className="flex items-center gap-3 rounded-2xl bg-surface-2 px-3 py-2.5 ring-1 ring-line">
            <Layers className="size-4 shrink-0 text-muted" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">
                {r ? [...r.chain.map((t) => t.name), ...(r.extensions ? [r.extensions.name] : [])].join(" › ") : "No template yet"}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">{image && <ImageBadge image={image} />}</div>
            </div>
            {r && image && <BuildButton image={image} />}
          </div>
        </section>

        <section>
          <SectionTitle>Projects</SectionTitle>
          {projects.length ? (
            <div className="space-y-1.5">
              {projects.map((p) => (
                <div key={p.id} className="flex items-center gap-2.5 rounded-xl bg-surface-2 px-3 py-2 text-sm ring-1 ring-line">
                  {p.kind === "github" ? <FolderGit2 className="size-4 shrink-0 text-muted" /> : <HardDriveDownload className="size-4 shrink-0 text-muted" />}
                  <span className="min-w-0 flex-1 truncate">~/Desktop/{p.as}</span>
                  <span className="truncate text-xs text-muted">{p.kind === "github" ? `cloned from ${p.repo}` : "copied in"}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted">None.</p>
          )}
        </section>

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

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">{children}</h3>;
}
