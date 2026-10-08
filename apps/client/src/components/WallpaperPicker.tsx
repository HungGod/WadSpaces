import { useRef, useState } from "react";
import { ImagePlus, Link2 } from "lucide-react";
import clsx from "clsx";
import { backend } from "@/data";
import { useApp } from "@/lib/store";
import type { Wallpaper } from "@/lib/types";
import { WALLPAPER_PRESETS, wallpaperStyle } from "./desktop/wallpapers";
import { Button, Input, Label } from "./ui";

/** A wadspace's background: a preset, a solid color, or an image (a link or an upload). */
export function WallpaperPicker({ value, onChange }: { value: Wallpaper; onChange: (w: Wallpaper) => void }) {
  const [url, setUrl] = useState("");
  const [uploading, setUploading] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const same = (w: Wallpaper) => w.type === value.type && w.value === value.value;

  const upload = async (f: File) => {
    setUploading(true);
    try {
      onChange({ type: "image", value: await backend.uploadImage(f) });
    } catch (e) {
      useApp.getState().toast({ title: "Couldn't use that image", body: (e as Error).message, tone: "error" });
    } finally {
      setUploading(false);
    }
  };

  return (
    <div>
      <div className="grid grid-cols-3 gap-2">
        {WALLPAPER_PRESETS.map((p) => (
          <button
            key={p.name}
            type="button"
            onClick={() => onChange(p.wallpaper)}
            className={clsx("group relative aspect-video overflow-hidden rounded-xl ring-1 transition-all", same(p.wallpaper) ? "ring-2 ring-accent ring-offset-2 ring-offset-surface" : "ring-line hover:ring-line-strong")}
            style={wallpaperStyle(p.wallpaper)}
            title={p.name}
          >
            <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-1.5 pb-1 pt-3 text-left text-[10px] font-medium text-white">{p.name}</span>
          </button>
        ))}
      </div>

      <div className="mt-4 flex items-center gap-3">
        <label className="relative size-10 shrink-0 cursor-pointer overflow-hidden rounded-xl ring-1 ring-line" style={{ background: value.type === "color" ? value.value : "conic-gradient(from 0deg, #ff3d81, #d4ff3d, #3dd4ff, #7c3aed, #ff3d81)" }} title="Solid color">
          <input type="color" value={value.type === "color" ? value.value : "#0a0614"} onChange={(e) => onChange({ type: "color", value: e.target.value })} className="absolute inset-0 cursor-pointer opacity-0" />
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
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Paste image URL" className="h-9 pl-8 text-[13px]" onKeyDown={(e) => e.key === "Enter" && url.trim() && onChange({ type: "image", value: url.trim() })} />
          </div>
          <Button size="sm" className="h-9" disabled={!url.trim()} onClick={() => onChange({ type: "image", value: url.trim() })}>Use</Button>
        </div>
        <input ref={file} type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
        <Button size="sm" variant="secondary" className="mt-2 w-full" disabled={uploading} onClick={() => file.current?.click()}>
          <ImagePlus className="size-3.5" /> {uploading ? "Uploading…" : "Upload image"}
        </Button>
      </div>
    </div>
  );
}
