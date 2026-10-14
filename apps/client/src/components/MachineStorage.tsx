// What WadSpaces takes on a machine's disk (wadd's /v1/storage), on the
// Machines page: the disk (how full, by what), and the wadspaces as the tree
// their layers make. Layers are shared: the base under every template, a
// template under the templates and Extensions built on it. So each layer
// shows its own share (what it adds to the image under it), and a wadspace
// its own files (its home and what it copied in). What a wadspace really
// costs is its own files plus the layers only it uses.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HardDrive, Loader2, RefreshCw } from "lucide-react";
import clsx from "clsx";
import { backend } from "@/data";
import { wadspaceName } from "@/data/layers";
import { chainOf, type LayerKey, type Wadspace } from "@core/layers";
import { alive, useApp } from "@/lib/store";
import type { Machine } from "@/lib/types";
import { useUi } from "@/lib/ui";
import { formatBytes, type Storage } from "@/lib/wadd";
import { IconButton } from "./ui";

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
}

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
  wadspace: "Wadspace",
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

  return (
    <div className="overflow-hidden rounded-3xl border border-line bg-surface">
      <div className="flex items-center justify-between border-b border-line px-5 py-4">
        <div>
          <h3 className="flex items-center gap-2 font-display text-lg font-semibold">
            <HardDrive className="size-4 text-accent" /> Storage
          </h3>
          <p className="mt-0.5 text-xs text-muted">What your wadspaces take on {m.label}&apos;s disk. Layers are shared: each shows what it adds to the one under it.</p>
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
          <DiskBar s={s} />
          <LayerTree s={s} m={m} />
        </div>
      )}
    </div>
  );
}

/** The disk: images, wadspaces' files, copies, everything else, and what's free. */
function DiskBar({ s }: { s: Storage }) {
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
    </div>
  );
}

/** The wadspaces as their layers make them: base → templates → Extensions → wadspaces. */
function LayerTree({ s, m }: { s: Storage; m: Machine }) {
  const templates = useApp((x) => x.templates);
  const extensions = useApp((x) => x.extensions);
  const wadspaces = useApp((x) => x.wadspaces);
  // The layers' notes (update, building) follow the images and builds.
  const images = useApp((x) => x.images);
  const builds = useApp((x) => x.builds);
  const openDetails = useUi((x) => x.openDetails);
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

  const nodes = useMemo(
    () => treeOf(s, m, { templates: alive(templates), extensions: alive(extensions) }, alive(wadspaces)),
    // images and builds aren't read here, but they change what imageState says.
    [s, m, templates, extensions, wadspaces, images, builds],
  );
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
            </>
          );
          const cls = clsx(
            "absolute flex items-center rounded-xl bg-surface-2 py-1.5 pr-2.5 text-left ring-1 transition-colors",
            n.bytes === null && n.kind !== "wadspace" ? "opacity-70 ring-line [outline:1px_dashed_var(--line-strong)]" : "ring-line",
          );
          const style = { left: p.x, top: p.y, width: NODE_W, height: NODE_H };
          return n.wadspaceId ? (
            <button key={n.key} type="button" className={clsx(cls, "hover:ring-line-strong")} style={style} onClick={() => openDetails(n.wadspaceId!)} title="See this wadspace">
              {body}
            </button>
          ) : (
            <div key={n.key} className={cls} style={style} title={n.bytes === null ? "Not built on this machine" : undefined}>
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
