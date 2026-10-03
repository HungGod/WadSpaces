import { useEffect, useState } from "react";
import { Plus, Search, Trash2 } from "lucide-react";
import { recipeFor } from "@core/catalog/recipes";
import { favicon } from "@/lib/favicon";
import { useApp } from "@/lib/store";
import type { App } from "@/lib/types";
import { APP_DRAG_TYPE, type DraggedApp } from "../desktop/Desktop";
import { Button, Input, Label, Modal } from "../ui";

export interface CatalogApp extends App {
  custom?: boolean;
}

const STORAGE_KEY = "ws-custom-apps";

function loadCustom(): CatalogApp[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
  } catch {
    return [];
  }
}

export function Catalog({ onAdd }: { onAdd: (app: DraggedApp) => void }) {
  const apps = useApp((s) => s.apps);
  const [custom, setCustom] = useState<CatalogApp[]>([]);
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);

  useEffect(() => setCustom(loadCustom()), []);
  const saveCustom = (next: CatalogApp[]) => {
    setCustom(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {}
  };

  const needle = q.trim().toLowerCase();
  const match = (a: CatalogApp) => !needle || a.name.toLowerCase().includes(needle) || a.domain.toLowerCase().includes(needle);
  const toDragged = (a: CatalogApp): DraggedApp => ({ appId: a.id, label: a.name, domain: a.domain, iconUrl: a.iconUrl, color: a.color });

  const tile = (a: CatalogApp) => {
    const r = recipeFor(a.id, a.custom ? a.domain : undefined);
    const soon = r.kind === "soon" ? r.reason : null;
    return (
    <div
      key={a.id}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(APP_DRAG_TYPE, JSON.stringify(toDragged(a)));
        e.dataTransfer.effectAllowed = "copy";
      }}
      onDoubleClick={() => onAdd(toDragged(a))}
      title={soon ? `${a.name}: coming soon. ${soon}. You can still place it; builds skip it for now.` : `${a.name}: drag onto the desktop (or double-click to add)`}
      className="group relative flex cursor-grab flex-col items-center gap-1.5 rounded-2xl px-1 pb-2 pt-2.5 text-center transition-colors hover:bg-surface-2 active:cursor-grabbing"
    >
      <span className="grid size-14 place-items-center rounded-[28%] bg-surface-2 ring-1 ring-line transition-transform group-hover:scale-105 group-hover:bg-surface-3">
        <img src={a.iconUrl ?? favicon(a.domain, 128)} alt="" className={`size-9 rounded-md ${soon ? "opacity-45 grayscale" : ""}`} draggable={false} />
      </span>
      <span className={`line-clamp-2 w-full text-[11.5px] leading-tight ${soon ? "text-faint" : ""}`}>{a.name}</span>
      {soon && <span className="absolute left-1 top-1 rounded-full bg-surface-3 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wider text-muted ring-1 ring-line">Soon</span>}
      {a.custom ? (
        <button type="button" onClick={() => saveCustom(custom.filter((c) => c.id !== a.id))} className="absolute right-1 top-1 hidden size-6 place-items-center rounded-full bg-surface text-faint shadow ring-1 ring-line hover:text-fg group-hover:grid" aria-label={`Remove ${a.name}`}>
          <Trash2 className="size-3" />
        </button>
      ) : (
        <button type="button" onClick={() => onAdd(toDragged(a))} className="absolute right-1 top-1 hidden size-6 place-items-center rounded-full bg-accent text-accent-fg shadow group-hover:grid" aria-label={`Add ${a.name}`}>
          <Plus className="size-3.5" />
        </button>
      )}
    </div>
    );
  };

  const customShown = custom.filter(match);
  const appsShown = apps.filter(match);

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search apps" className="h-9 pl-9" />
        </div>
        <Button size="sm" className="w-full" onClick={() => setAdding(true)}>
          <Plus className="size-3.5" /> Custom app
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain px-2 pb-3">
        {customShown.length > 0 && (
          <>
            <div className="px-2 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-faint">Custom</div>
            <div className="grid grid-cols-3 gap-1">{customShown.map(tile)}</div>
          </>
        )}
        <div className="px-2 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-faint">Applications</div>
        <div className="grid grid-cols-3 gap-1">{appsShown.map(tile)}</div>
        {!appsShown.length && !customShown.length && <p className="px-2 py-6 text-center text-sm text-muted">No apps match “{q}”.</p>}
      </div>
      <CustomAppDialog open={adding} onClose={() => setAdding(false)} onCreate={(a) => saveCustom([a, ...custom])} />
    </div>
  );
}

function CustomAppDialog({ open, onClose, onCreate }: { open: boolean; onClose: () => void; onCreate: (a: CatalogApp) => void }) {
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [iconUrl, setIconUrl] = useState("");
  const [color, setColor] = useState("#ff3d81");

  useEffect(() => {
    if (open) {
      setName("");
      setDomain("");
      setIconUrl("");
      setColor("#ff3d81");
    }
  }, [open]);

  const preview = iconUrl.trim() || (domain.trim() ? favicon(domain.trim(), 64) : "");

  return (
    <Modal open={open} onClose={onClose} title="Add a custom app" subtitle="Any website, opened in its own app window. The icon comes from the site unless you give an image URL." width={440}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim() || (!domain.trim() && !iconUrl.trim())) return;
          onCreate({ id: `custom-${Date.now().toString(36)}`, name: name.trim(), domain: domain.trim(), color, iconUrl: iconUrl.trim() || undefined, custom: true });
          onClose();
        }}
      >
        <div className="flex items-end gap-3">
          <div className="grid size-14 shrink-0 place-items-center rounded-2xl ring-1 ring-line" style={{ background: color }}>
            {preview && <img src={preview} alt="" className="size-8 rounded-lg" />}
          </div>
          <div className="flex-1">
            <Label>Name</Label>
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Kale Browser" />
          </div>
        </div>
        <div>
          <Label>Website</Label>
          <Input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="kalebrowser.com" />
        </div>
        <div>
          <Label hint="optional">Icon image URL</Label>
          <Input value={iconUrl} onChange={(e) => setIconUrl(e.target.value)} placeholder="https://…/icon.png" />
        </div>
        <div>
          <Label>Window color</Label>
          <div className="flex items-center gap-3">
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-10 w-14 cursor-pointer rounded-lg bg-transparent" />
            <code className="font-mono text-sm text-muted">{color}</code>
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!name.trim() || (!domain.trim() && !iconUrl.trim())}>Add app</Button>
        </div>
      </form>
    </Modal>
  );
}
