import { useRef, useState } from "react";
import { ImagePlus } from "lucide-react";
import clsx from "clsx";
import { backend } from "@/data";
import { useApp } from "@/lib/store";
import type { Wallpaper } from "@/lib/types";
import { WALLPAPER_PRESETS, wallpaperStyle } from "./desktop/wallpapers";

/** A wadspace's background: one of the shaded gradients, or a picture from this computer. */
export function WallpaperPicker({ value, onChange }: { value: Wallpaper; onChange: (w: Wallpaper) => void }) {
  const [loading, setLoading] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const same = (w: Wallpaper) => w.type === value.type && w.value === value.value;
  const mine = value.type === "image";

  const choose = async (f: File) => {
    setLoading(true);
    try {
      onChange({ type: "image", value: await backend.uploadImage(f) });
    } catch (e) {
      useApp.getState().toast({ title: "Couldn't use that picture", body: (e as Error).message, tone: "error" });
    } finally {
      setLoading(false);
    }
  };

  return (
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
      {mine && (
        <button type="button" className="relative aspect-video overflow-hidden rounded-xl ring-2 ring-accent ring-offset-2 ring-offset-surface" style={wallpaperStyle(value)} title="Your picture">
          <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-1.5 pb-1 pt-3 text-left text-[10px] font-medium text-white">Your picture</span>
        </button>
      )}
      <button
        type="button"
        disabled={loading}
        onClick={() => file.current?.click()}
        className="flex aspect-video flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-line-strong text-[11px] font-medium text-muted transition-colors hover:border-accent hover:text-fg"
      >
        <ImagePlus className="size-4" /> {loading ? "Loading…" : "Choose a picture…"}
      </button>
      <input ref={file} type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && choose(e.target.files[0])} />
    </div>
  );
}
