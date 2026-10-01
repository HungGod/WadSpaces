import { useRef, useState } from "react";
import { Grid3x3, ImagePlus, LayoutGrid, Link2, Lock, Power, Trash2, Users } from "lucide-react";
import clsx from "clsx";
import { backend } from "@/data";
import { useApp } from "@/lib/store";
import type { Layout, Visibility, Wallpaper } from "@/lib/types";
import { WALLPAPER_PRESETS, wallpaperStyle } from "../desktop/wallpapers";
import { Button, Input, Label, Segmented, Textarea, Toggle } from "../ui";
import { localIcon } from "@core/catalog/icons";

/** Step 3 of the Builder: what the wadspace is called, who can see it, and its background. */
export function Customize({ name, setName, description, setDescription, visibility, setVisibility, layout, commit, highlightWallpaper }: {
  name: string;
  setName: (v: string) => void;
  description: string;
  setDescription: (v: string) => void;
  visibility: Visibility;
  setVisibility: (v: Visibility) => void;
  layout: Layout;
  commit: (l: Layout) => void;
  highlightWallpaper: boolean;
}) {
  const [url, setUrl] = useState("");
  const [uploading, setUploading] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const setWallpaper = (wallpaper: Wallpaper) => commit({ ...layout, wallpaper });
  const same = (w: Wallpaper) => w.type === layout.wallpaper.type && w.value === layout.wallpaper.value;

  const upload = async (f: File) => {
    setUploading(true);
    try {
      setWallpaper({ type: "image", value: await backend.uploadImage(f) });
    } catch (e) {
      useApp.getState().toast({ title: "Couldn't use that image", body: (e as Error).message, tone: "error" });
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-7 p-4">
      <section>
        <Heading>Details</Heading>
        <Label>Title</Label>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name your wadspace" aria-label="Wadspace title" />
        <div className="mt-4">
          <Label>Description</Label>
          <Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What's this wadspace for?" />
        </div>
        <div className="mt-4">
          <Label>Visibility</Label>
          <Segmented
            value={visibility}
            onChange={setVisibility}
            className="w-full"
            options={[
              { value: "private", label: <><Lock className="size-3.5" /> Private</> },
              { value: "shared", label: <><Users className="size-3.5" /> Shared</> },
            ]}
          />
        </div>
      </section>

      <section id="wallpaper" className={clsx("-mx-2 rounded-2xl px-2 py-2 transition-colors duration-500", highlightWallpaper && "bg-accent-soft ring-1 ring-accent/40")}>
        <Heading>Background</Heading>
        <div className="grid grid-cols-3 gap-2">
          {WALLPAPER_PRESETS.map((p) => (
            <button
              key={p.name}
              type="button"
              onClick={() => setWallpaper(p.wallpaper)}
              className={clsx("group relative aspect-video overflow-hidden rounded-xl ring-1 transition-all", same(p.wallpaper) ? "ring-2 ring-accent ring-offset-2 ring-offset-surface" : "ring-line hover:ring-line-strong")}
              style={wallpaperStyle(p.wallpaper)}
              title={p.name}
            >
              <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-1.5 pb-1 pt-3 text-left text-[10px] font-medium text-white">{p.name}</span>
            </button>
          ))}
        </div>

        <div className="mt-4 flex items-center gap-3">
          <label className="relative size-10 shrink-0 cursor-pointer overflow-hidden rounded-xl ring-1 ring-line" style={{ background: layout.wallpaper.type === "color" ? layout.wallpaper.value : "conic-gradient(from 0deg, #ff3d81, #d4ff3d, #3dd4ff, #7c3aed, #ff3d81)" }} title="Solid color">
            <input type="color" value={layout.wallpaper.type === "color" ? layout.wallpaper.value : "#0a0614"} onChange={(e) => setWallpaper({ type: "color", value: e.target.value })} className="absolute inset-0 cursor-pointer opacity-0" />
          </label>
          <div className="text-xs text-muted">
            <div className="font-medium text-fg">Solid color</div>
            Click the swatch to pick any color.
          </div>
        </div>

        <div className="mt-4">
          <Label>Image</Label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Link2 className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
              <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Paste image URL" className="h-9 pl-8 text-[13px]" onKeyDown={(e) => e.key === "Enter" && url.trim() && setWallpaper({ type: "image", value: url.trim() })} />
            </div>
            <Button size="sm" className="h-9" disabled={!url.trim()} onClick={() => setWallpaper({ type: "image", value: url.trim() })}>Use</Button>
          </div>
          <input ref={file} type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
          <Button size="sm" variant="secondary" className="mt-2 w-full" disabled={uploading} onClick={() => file.current?.click()}>
            <ImagePlus className="size-3.5" /> {uploading ? "Uploading…" : "Upload image"}
          </Button>
        </div>
      </section>
    </div>
  );
}

/** The right-hand Desktop tab: grid, startup apps and shortcuts. */
export function DesktopSettings({ layout, commit, onArrange }: { layout: Layout; commit: (l: Layout) => void; onArrange: () => void }) {
  return (
    <div className="h-full space-y-7 overflow-y-auto p-4">
      <section>
        <Heading>Desktop</Heading>
        <div className="flex items-center justify-between rounded-xl bg-surface-2 px-3 py-2.5 ring-1 ring-line">
          <span className="flex items-center gap-2 text-sm"><Grid3x3 className="size-4 text-muted" /> Snap icons to grid</span>
          <Toggle checked={layout.grid} onChange={(grid) => commit({ ...layout, grid })} label="Snap icons to grid" />
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <Button size="sm" onClick={onArrange} disabled={!layout.icons.length}>
            <LayoutGrid className="size-3.5" /> Arrange
          </Button>
          <Button size="sm" variant="danger" onClick={() => layout.icons.length && confirm("Remove every icon from the desktop?") && commit({ ...layout, icons: [] })} disabled={!layout.icons.length}>
            <Trash2 className="size-3.5" /> Clear
          </Button>
        </div>
        <p className="mt-2 text-xs text-faint">{layout.icons.length} app{layout.icons.length === 1 ? "" : "s"} on the desktop</p>
      </section>

      <section>
        <Heading>Startup apps</Heading>
        {layout.icons.length ? (
          <>
            <div className="space-y-1">
              {layout.icons.map((icon) => (
                <div key={icon.id} className="flex items-center gap-2.5 rounded-xl px-2 py-1.5 hover:bg-surface-2">
                  <img src={localIcon(icon.iconUrl)} alt="" className="size-5 shrink-0 rounded" />
                  <span className="min-w-0 flex-1 truncate text-sm">{icon.label}</span>
                  <Toggle
                    checked={!!icon.autostart}
                    onChange={(on) => commit({ ...layout, icons: layout.icons.map((i) => (i.id === icon.id ? { ...i, autostart: on } : i)) })}
                    label={`Open ${icon.label} on startup`}
                  />
                </div>
              ))}
            </div>
            <p className="mt-2 flex items-center gap-1.5 text-xs text-faint">
              <Power className="size-3" /> {layout.icons.filter((i) => i.autostart).length || "No"} app{layout.icons.filter((i) => i.autostart).length === 1 ? "" : "s"} open when the wadspace boots
            </p>
          </>
        ) : (
          <p className="text-xs text-faint">Add apps to the desktop, then pick which ones open as soon as the wadspace boots.</p>
        )}
      </section>

      <section>
        <Heading>Shortcuts</Heading>
        <dl className="space-y-1.5 text-xs">
          {[
            ["Double-click icon", "Open window"],
            ["Right-click icon", "Rename, re-icon, startup"],
            ["Drag title bar to edge", "Snap left / right / max"],
            ["Double-click title bar", "Maximize / restore"],
            ["Del · F2 · Enter", "Remove · rename · open"],
            ["Ctrl+Z · Ctrl+Shift+Z", "Undo · redo"],
          ].map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3">
              <dt className="text-muted">{k}</dt>
              <dd className="text-right text-fg">{v}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-3 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-faint">{children}</h3>;
}
