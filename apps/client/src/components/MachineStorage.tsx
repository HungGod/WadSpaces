// What WadSpaces takes on a machine's disk (wadd's /v1/storage), on the
// Machines page: the disk (how full, by what), and the wadspaces as the tree
// their layers make. Layers are shared: the base under every template, a
// template under the templates and Extensions built on it. So each layer
// shows its own share (what it adds to the image under it), and a wadspace
// its own files (its home and what it copied in). What a wadspace really
// costs is its own files plus the layers only it uses.
//
// Templates, Extensions and Customizations (a wadspace here, with its files)
// are picked in the tree and deleted from the disk, just what's picked: a
// layer something else is built on keeps its files until that goes too.
// Older builds nothing needs go on their own line.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, HardDrive, Loader2, RefreshCw, Trash2, X } from "lucide-react";
import clsx from "clsx";
import { backend } from "@/data";
import { wadspaceName } from "@/data/layers";
import { chainOf, type LayerKey, type Wadspace } from "@core/layers";
import { alive, useApp } from "@/lib/store";
import type { Machine } from "@/lib/types";
import { formatBytes, type Freed, type Storage } from "@/lib/wadd";
import { Button, IconButton, Modal } from "./ui";

type Kind = "base" | "template" | "extensions" | "wadspace";

interface Node {
  key: string;
  kind: Kind;
  name: string;
  /** Its own share of the disk; null when it isn't on the machine (not built). */
  bytes: number | null;
  parent: string | null;
  col: number;
  /** A layer: "update" or "changed" (built, but not as it is now). A wadspace: running, installed or not here. */
  note?: string;
  tone?: "on" | "dim" | "warn";
  wadspaceId?: string;
  /** A wadspace: on this machine (and running). */
  installed?: boolean;
  running?: boolean;
}

/** What can be picked to delete: a built layer (not the base), or a wadspace on this machine. */
const pickable = (n: Node) => (n.kind === "wadspace" ? !!n.installed : n.kind !== "base" && n.bytes !== null);

const COLOR: Record<Kind, string> = {
  base: "var(--muted)",
  template: "var(--layer-template)",
  extensions: "var(--layer-extensions)",
  wadspace: "var(--layer-customization)",
};
const KIND_LABEL: Record<Kind, string> = {
  base: "Base",
  template: "Template",
  extensions: "Extensions",
  wadspace: "Customization",
};

const NODE_W = 184;
/** Room between columns for the edges, at the least. */
const MIN_COL_W = NODE_W + 28;
const ROW_H = 62;
const NODE_H = 50;

/** The storage card: the disk bar, then the tree. Refreshed every minute (wadd measures at most that often). */
export function MachineStorage({ m }: { m: Machine }) {
  const [s, setS] = useState<Storage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async (fresh = false) => {
    if (!backend.storage) return;
    setBusy(true);
    try {
      setS(await backend.storage(fresh));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, [load]);

  // The tree's nodes, and what's picked in it.
  const nodes = useStorageNodes(s, m);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const toggle = (key: string) => setPicked((p) => (p.has(key) ? new Set([...p].filter((k) => k !== key)) : new Set([...p, key])));
  const done = (f: Freed) => {
    setPicked(new Set());
    const what = [f.removed.length && `${f.removed.length} image${f.removed.length === 1 ? "" : "s"}`, f.uninstalled.length && `${f.uninstalled.join(", ")} and ${f.uninstalled.length === 1 ? "its" : "their"} files`].filter(Boolean).join(" and ");
    useApp.getState().toast({
      title: `Freed about ${formatBytes(f.bytes)}`,
      body: `${what ? `Deleted ${what}.` : "Nothing needed deleting."}${f.kept.length ? ` ${f.kept.join(", ")} kept ${f.kept.length === 1 ? "its" : "their"} files: an image here is built on ${f.kept.length === 1 ? "it" : "them"}.` : ""}`,
      tone: "success",
    });
    void load(true);
    void useApp.getState().loadImages();
    void useApp.getState().loadMachines();
  };

  return (
    <div className="overflow-hidden rounded-3xl border border-line bg-surface">
      <div className="flex items-center justify-between border-b border-line px-5 py-4">
        <div>
          <h3 className="flex items-center gap-2 font-display text-lg font-semibold">
            <HardDrive className="size-4 text-accent" /> Storage
          </h3>
          <p className="mt-0.5 text-xs text-muted">
            What your wadspaces take on {m.label}&apos;s disk. Layers are shared: each shows what it adds to the one under it. Click templates, Extensions or Customizations to delete them from this machine.
          </p>
        </div>
        <IconButton label="Measure again" onClick={() => void load(true)} disabled={busy}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
        </IconButton>
      </div>
      {error ? (
        <p className="m-5 rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger ring-1 ring-danger/30">{error}</p>
      ) : !s ? (
        <p className="p-5 text-sm text-muted">Measuring…</p>
      ) : (
        <div className="space-y-6 p-5">
          <DiskBar s={s} onFreed={done} />
          <LayerTree nodes={nodes} picked={picked} onToggle={toggle} />
          {picked.size > 0 && <PickedBar nodes={nodes} picked={picked} setPicked={setPicked} onFreed={done} />}
        </div>
      )}
    </div>
  );
}

/** The disk: images, wadspaces' files, copies, everything else, and what's free. */
function DiskBar({ s, onFreed }: { s: Storage; onFreed: (f: Freed) => void }) {
  const old = (s.leftovers ?? []).reduce((n, l) => n + l.ownBytes, 0);
  const [pruning, setPruning] = useState(false);
  const prune = async () => {
    setPruning(true);
    try {
      onFreed(await backend.pruneOld!());
    } catch (e) {
      useApp.getState().toast({ title: "Couldn't delete the old builds", body: (e as Error).message, tone: "error" });
    } finally {
      setPruning(false);
    }
  };
  const images = (s.base?.bytes ?? 0) + s.layers.reduce((n, l) => n + l.ownBytes, 0);
  const homes = s.homes.reduce((n, h) => n + h.bytes, 0);
  const copies = s.copies.reduce((n, c) => n + c.bytes, 0);
  const total = s.disk.totalBytes || 1;
  const used = Math.max(0, s.disk.totalBytes - s.disk.freeBytes);
  const other = Math.max(0, used - images - homes - copies);
  const parts = [
    { label: "Images", bytes: images, color: "var(--layer-template)" },
    {
      label: "Wadspaces' files",
      bytes: homes,
      color: "var(--layer-customization)",
    },
    { label: "Copied in", bytes: copies, color: "var(--layer-extensions)" },
    { label: "Everything else", bytes: other, color: "var(--faint)" },
  ];
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2 text-sm">
        <span className="font-semibold">WadSpaces uses {formatBytes(images + homes + copies)}</span>
        <span className="font-mono text-xs text-muted">
          {formatBytes(s.disk.freeBytes)} free of {formatBytes(s.disk.totalBytes)}
        </span>
      </div>
      <div
        className="flex h-3.5 overflow-hidden rounded-full bg-surface-3 ring-1 ring-line"
        role="img"
        aria-label={`Disk: ${formatBytes(used)} used of ${formatBytes(s.disk.totalBytes)}`}
      >
        {parts.map((p) =>
          p.bytes > 0 ? (
            <div
              key={p.label}
              title={`${p.label}: ${formatBytes(p.bytes)}`}
              style={{
                width: `${(100 * p.bytes) / total}%`,
                background: p.color,
              }}
              className="h-full min-w-[3px] border-r border-bg/60 last:border-0"
            />
          ) : null,
        )}
      </div>
      <div className="mt-2.5 flex flex-wrap gap-x-5 gap-y-1.5 text-xs text-muted">
        {parts.map((p) => (
          <span key={p.label} className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm" style={{ background: p.color }} />
            {p.label} <span className="font-mono text-fg">{formatBytes(p.bytes)}</span>
          </span>
        ))}
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-surface-3 ring-1 ring-line" /> Free <span className="font-mono text-fg">{formatBytes(s.disk.freeBytes)}</span>
        </span>
      </div>
      {s.leftovers?.length > 0 && backend.pruneOld && (
        <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl bg-surface-2 px-3 py-2 text-xs ring-1 ring-line">
          <span className="min-w-0 flex-1 text-muted">
            <span className="font-medium text-fg">Old builds</span>: {s.leftovers.length} earlier build{s.leftovers.length === 1 ? "" : "s"} of layers nothing needs any more, {formatBytes(old)}.
          </span>
          <Button size="sm" variant="ghost" disabled={pruning} onClick={() => void prune()}>
            {pruning ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />} Delete them
          </Button>
        </div>
      )}
    </div>
  );
}

/** The wadspaces as their layers make them: base → templates → Extensions → wadspaces. */
function useStorageNodes(s: Storage | null, m: Machine): Node[] {
  const templates = useApp((x) => x.templates);
  const extensions = useApp((x) => x.extensions);
  const wadspaces = useApp((x) => x.wadspaces);
  // The layers' notes (update, building) follow the images and builds.
  const images = useApp((x) => x.images);
  const builds = useApp((x) => x.builds);
  return useMemo(
    () => (s ? treeOf(s, m, { templates: alive(templates), extensions: alive(extensions) }, alive(wadspaces)) : []),
    // images and builds aren't read here, but they change what imageState says.
    [s, m, templates, extensions, wadspaces, images, builds],
  );
}

function LayerTree({ nodes, picked, onToggle }: { nodes: Node[]; picked: Set<string>; onToggle: (key: string) => void }) {
  // The columns share the card's width (scrolling sideways only when they can't fit).
  const box = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setAvail(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const laid = useMemo(() => layout(nodes), [nodes]);
  const colW = laid.cols && avail ? Math.max(MIN_COL_W, Math.floor((avail - NODE_W) / laid.cols)) : MIN_COL_W;
  const width = laid.cols * colW + NODE_W;
  const height = laid.rows * ROW_H;
  const at = (n: Node) => ({
    x: n.col * colW,
    y: (laid.y.get(n.key) ?? 0) * ROW_H + (ROW_H - NODE_H) / 2,
  });

  if (laid.rows === 0) return <p className="text-sm text-muted">No wadspaces yet: make one in the Builder.</p>;
  return (
    <div ref={box} className="overflow-x-auto pb-1">
      <div className="relative" style={{ width, height }}>
        <svg className="pointer-events-none absolute inset-0" width={width} height={height} aria-hidden>
          {nodes
            .filter((n) => n.parent)
            .map((n) => {
              const p = nodes.find((x) => x.key === n.parent)!;
              const a = at(p);
              const b = at(n);
              const [x1, y1, x2, y2] = [a.x + NODE_W, a.y + NODE_H / 2, b.x, b.y + NODE_H / 2];
              const mid = (x1 + x2) / 2;
              return (
                <path
                  key={n.key}
                  d={`M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`}
                  fill="none"
                  stroke={COLOR[n.kind]}
                  strokeOpacity={n.bytes === null ? 0.3 : 0.55}
                  strokeWidth={1.5}
                  strokeDasharray={n.bytes === null ? "4 4" : undefined}
                />
              );
            })}
        </svg>
        {nodes.map((n) => {
          const p = at(n);
          const on = picked.has(n.key);
          const body = (
            <>
              <span className="absolute inset-y-1.5 left-1.5 w-1 rounded-full" style={{ background: COLOR[n.kind] }} />
              <span className="min-w-0 flex-1 pl-4">
                <span className="block text-[10px] font-semibold uppercase tracking-wider" style={{ color: COLOR[n.kind] }}>
                  {KIND_LABEL[n.kind]}
                </span>
                <span className="block truncate text-[13px] font-medium">{n.name}</span>
              </span>
              <span className="shrink-0 pl-2 text-right">
                <span className="block font-mono text-xs">{n.bytes === null ? "—" : formatBytes(n.bytes)}</span>
                {n.note && (
                  <span className={clsx("block text-[10px]", n.tone === "on" ? "text-accent" : n.tone === "warn" ? "text-[var(--layer-template)]" : "text-faint")}>{n.note}</span>
                )}
              </span>
              {on && (
                <span className="absolute -right-1.5 -top-1.5 grid size-4 place-items-center rounded-full bg-danger text-white ring-2 ring-surface">
                  <Check className="size-2.5" strokeWidth={3} />
                </span>
              )}
            </>
          );
          const cls = clsx(
            "absolute flex items-center rounded-xl bg-surface-2 py-1.5 pr-2.5 text-left transition-all",
            on ? "ring-2 ring-danger" : "ring-1 ring-line",
            n.bytes === null && n.kind !== "wadspace" && "opacity-70 [outline:1px_dashed_var(--line-strong)]",
          );
          const style = { left: p.x, top: p.y, width: NODE_W, height: NODE_H };
          return pickable(n) ? (
            <button key={n.key} type="button" aria-pressed={on} className={clsx(cls, !on && "hover:ring-line-strong")} style={style} onClick={() => onToggle(n.key)} title={on ? "Picked to delete: click to leave it" : "Click to pick it to delete"}>
              {body}
            </button>
          ) : (
            <div key={n.key} className={cls} style={style} title={n.kind === "base" ? "The base every template builds on: it stays" : n.bytes === null ? "Not on this machine" : undefined}>
              {body}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The nodes: the base, each template on the way to a wadspace (in its chain), its Extensions, the wadspaces. */
function treeOf(
  s: Storage,
  m: Machine,
  lib: Parameters<typeof chainOf>[0] & {
    extensions: { id: string; name: string; templateId: string }[];
  },
  stacks: Wadspace[],
): Node[] {
  const own = new Map(s.layers.map((l) => [l.layer, l.ownBytes]));
  const homes = new Map(s.homes.map((h) => [h.workspaceId, h.bytes]));
  const copies = new Map(s.copies.map((c) => [c.id, c.bytes]));
  const state = useApp.getState().imageState;
  const layerNote = (key: LayerKey): Pick<Node, "note" | "tone"> => {
    const st = state(key);
    return st === "update"
      ? { note: "update available", tone: "warn" }
      : st === "changed"
        ? { note: "changed since", tone: "warn" }
        : st === "building"
          ? { note: "building…", tone: "on" }
          : {};
  };
  const nodes = new Map<string, Node>();
  const add = (n: Node) => !nodes.has(n.key) && nodes.set(n.key, n);
  const chains = stacks.map((w) => (w.template ? chainOf(lib, w.template) : [])).filter((c) => c.length);
  const depth = Math.max(0, ...chains.map((c) => c.length));
  add({
    key: "base",
    kind: "base",
    name: "WadSpaces base",
    bytes: s.base?.bytes ?? null,
    parent: null,
    col: 0,
  });
  for (const w of stacks) {
    const chain = w.template ? chainOf(lib, w.template) : [];
    if (!chain.length) continue;
    chain.forEach((t, i) => {
      const key = `template:${t.id}` as LayerKey;
      add({
        key,
        kind: "template",
        name: t.name,
        bytes: own.get(key) ?? null,
        parent: i ? `template:${chain[i - 1].id}` : "base",
        col: i + 1,
        ...layerNote(key),
      });
    });
    let parent = `template:${chain[chain.length - 1].id}`;
    const e = w.extensions ? lib.extensions.find((x) => x.id === w.extensions) : undefined;
    if (e) {
      const key = `custom:${e.id}` as LayerKey;
      add({
        key,
        kind: "extensions",
        name: e.name,
        bytes: own.get(key) ?? null,
        parent,
        col: depth + 1,
        ...layerNote(key),
      });
      parent = key;
    }
    const c = m.containers.find((x) => x.wadspaceId === w.id);
    const copied = (w.customization?.projects ?? []).reduce((n, p) => n + (p.kind === "copy" ? (copies.get(p.id) ?? 0) : 0), 0);
    const home = homes.get(w.id);
    add({
      key: `ws:${w.id}`,
      kind: "wadspace",
      name: wadspaceName(w),
      bytes: c || home !== undefined ? (home ?? 0) + copied : null,
      parent,
      col: depth + 2,
      wadspaceId: w.id,
      installed: !!c,
      running: c?.status === "running",
      ...(c?.status === "running" ? { note: "running", tone: "on" as const } : c ? { note: "installed", tone: "dim" as const } : { note: "not built here", tone: "dim" as const }),
    });
  }
  return [...nodes.values()];
}

/** Rows for the wadspaces (the leaves, in tree order), each node centred on what's built on it. */
function layout(nodes: Node[]): {
  y: Map<string, number>;
  rows: number;
  cols: number;
} {
  const kids = new Map<string, Node[]>();
  for (const n of nodes) if (n.parent) kids.set(n.parent, [...(kids.get(n.parent) ?? []), n]);
  for (const list of kids.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  const y = new Map<string, number>();
  let row = 0;
  const place = (key: string): number => {
    const list = kids.get(key) ?? [];
    if (!list.length) {
      y.set(key, row);
      return row++;
    }
    const ys = list.map((k) => place(k.key));
    const mid = (ys[0] + ys[ys.length - 1]) / 2;
    y.set(key, mid);
    return mid;
  };
  // Only the base and what's built on it (nothing at all when there are no wadspaces).
  if (nodes.some((n) => n.kind === "wadspace")) place("base");
  return { y, rows: row, cols: Math.max(0, ...nodes.map((n) => n.col)) };
}

/** What's picked: what it frees, what stops it, and the delete (after a look at what goes). */
function PickedBar({ nodes, picked, setPicked, onFreed }: { nodes: Node[]; picked: Set<string>; setPicked: (p: Set<string>) => void; onFreed: (f: Freed) => void }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const kids = (key: string) => nodes.filter((n) => n.parent === key);
  const descendants = (key: string): Node[] => kids(key).flatMap((k) => [k, ...descendants(k.key)]);
  const sel = nodes.filter((n) => picked.has(n.key) && pickable(n));
  const layers = sel.filter((n) => n.kind === "template" || n.kind === "extensions");
  const wadspaces = sel.filter((n) => n.kind === "wadspace");
  // What stops it: a picked wadspace running; one on a picked layer's image, not picked.
  const running = wadspaces.filter((n) => n.running);
  const onIt = layers.flatMap((l) => kids(l.key).filter((k) => k.kind === "wadspace" && k.installed && !picked.has(k.key)));
  // A layer something unpicked is built on: its name goes, its files stay.
  const keptBy = (l: Node) => kids(l.key).filter((k) => k.kind !== "wadspace" && k.bytes !== null && !picked.has(k.key));
  const frees = [...wadspaces, ...layers.filter((l) => !keptBy(l).length)].reduce((n, x) => n + (x.bytes ?? 0), 0);
  const more = [...new Set(layers.flatMap((l) => descendants(l.key)))].filter((n) => pickable(n) && !picked.has(n.key));
  const blocked = running.length > 0 || onIt.length > 0;
  const add = (list: Node[]) => setPicked(new Set([...picked, ...list.map((n) => n.key)]));

  const go = async () => {
    setBusy(true);
    try {
      onFreed(await backend.deleteFromDisk!({ layers: layers.map((n) => n.key), wadspaces: wadspaces.map((n) => n.wadspaceId!) }));
      setAsking(false);
    } catch (e) {
      useApp.getState().toast({ title: "Couldn't delete them", body: (e as Error).message, tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-2xl bg-surface-2 p-3 ring-1 ring-danger/40">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 text-sm">
          <span className="font-semibold">{sel.length} picked</span>
          <span className="text-muted"> · frees about {formatBytes(frees)}</span>
        </span>
        {more.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => add(more)} title={more.map((n) => n.name).join(", ")}>
            Pick what&apos;s built on {layers.length === 1 ? "it" : "them"} (+{more.length})
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => setPicked(new Set())}>
          <X className="size-3.5" /> Clear
        </Button>
        <Button size="sm" variant="danger" disabled={blocked || !backend.deleteFromDisk} onClick={() => setAsking(true)}>
          <Trash2 className="size-3.5" /> Delete…
        </Button>
      </div>
      {(running.length > 0 || onIt.length > 0 || layers.some((l) => keptBy(l).length)) && (
        <ul className="mt-2 space-y-1 text-xs text-muted">
          {running.map((n) => (
            <li key={`run-${n.key}`} className="text-danger">
              {n.name} is running: stop it first.
            </li>
          ))}
          {onIt.map((n) => (
            <li key={`on-${n.key}`} className="flex flex-wrap items-center gap-2">
              <span className="text-danger">{n.name} runs on a picked image.</span>
              <button type="button" className="font-medium text-fg underline underline-offset-2" onClick={() => add([n])}>
                Pick it too
              </button>
            </li>
          ))}
          {layers
            .filter((l) => keptBy(l).length)
            .map((l) => (
              <li key={`kept-${l.key}`}>
                {l.name}&apos;s files stay while {keptBy(l).map((k) => k.name).join(", ")} {keptBy(l).length === 1 ? "is" : "are"} built on it: only its name goes.
              </li>
            ))}
        </ul>
      )}
      <Modal open={asking} onClose={() => !busy && setAsking(false)} title="Delete from this machine?" subtitle="Only from this machine's disk: your library keeps every design, to build again." width={560}>
        <ul className="space-y-2 text-sm">
          {wadspaces.map((n) => (
            <li key={n.key} className="rounded-xl bg-surface-2 px-3 py-2 ring-1 ring-line">
              <span className="font-medium">{n.name}</span> <span className="text-muted">(Customization)</span>
              <div className="text-xs text-muted">
                Taken off this machine, and its files here deleted for good: what&apos;s in its home and the copies only it had{n.bytes ? ` (${formatBytes(n.bytes)})` : ""}.
              </div>
            </li>
          ))}
          {layers.map((n) => (
            <li key={n.key} className="rounded-xl bg-surface-2 px-3 py-2 ring-1 ring-line">
              <span className="font-medium">{n.name}</span> <span className="text-muted">({KIND_LABEL[n.kind]})</span>
              <div className="text-xs text-muted">
                {keptBy(n).length
                  ? `Its name goes; its files stay while ${keptBy(n).map((k) => k.name).join(", ")} ${keptBy(n).length === 1 ? "is" : "are"} built on it.`
                  : `Its image deleted, and its older builds${n.bytes ? ` (${formatBytes(n.bytes)})` : ""}. Built again when a wadspace on it is built.`}
              </div>
            </li>
          ))}
        </ul>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={() => setAsking(false)}>
            Cancel
          </Button>
          <Button variant="danger" disabled={busy} onClick={() => void go()}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />} Delete, freeing about {formatBytes(frees)}
          </Button>
        </div>
      </Modal>
    </div>
  );
}
