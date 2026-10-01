import { useRef, useState } from "react";
import { motion } from "motion/react";
import { Globe, Link2, Upload, X } from "lucide-react";
import clsx from "clsx";
import type { LayoutIcon } from "@/lib/types";
import { favicon } from "@/lib/favicon";
import { backend } from "@/data";
import { useApp } from "@/lib/store";
import { localIcon } from "@core/catalog/icons";

const SWATCHES = ["#c6ff1f", "#ff3d81", "#7c3aed", "#0e7fd6", "#1db954", "#ff7139", "#e87d0d", "#24292f", "#2f2f2f", "#5865f2", "#c96442", "#0a0614"];

type Source = "domain" | "url" | "upload";

export function IconEditor({ icon, onSave, onCancel }: { icon: LayoutIcon; onSave: (i: LayoutIcon) => void; onCancel: () => void }) {
  const [label, setLabel] = useState(icon.label);
  const [color, setColor] = useState(icon.color);
  const [iconUrl, setIconUrl] = useState(icon.iconUrl);
  const [source, setSource] = useState<Source>("domain");
  const [domain, setDomain] = useState(() => new URL(icon.iconUrl, "http://x").searchParams.get("domain") ?? "");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  const upload = async (f: File) => {
    setBusy(true);
    try {
      setIconUrl(await backend.uploadImage(f));
    } catch (e) {
      useApp.getState().toast({ title: "Couldn't use that image", body: (e as Error).message, tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="absolute inset-0 z-[9600] grid place-items-center bg-black/40 backdrop-blur-[2px]" onPointerDown={onCancel} onContextMenu={(e) => e.stopPropagation()}>
      <motion.form
        initial={{ opacity: 0, y: 10, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        onPointerDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          onSave({ ...icon, label: label.trim() || icon.label, color, iconUrl });
        }}
        className="w-[360px] rounded-2xl border border-white/10 bg-[#140d22]/95 p-4 text-white shadow-2xl backdrop-blur-xl"
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="font-display text-base font-semibold">Edit icon</h3>
          <button type="button" onClick={onCancel} className="rounded-md p-1 text-white/60 hover:bg-white/10 hover:text-white" aria-label="Close">
            <X className="size-4" />
          </button>
        </div>

        <div className="mb-4 flex items-center gap-3">
          <div className="grid size-16 shrink-0 place-items-center rounded-2xl ring-1 ring-white/15" style={{ background: color }}>
            <img src={localIcon(iconUrl)} alt="" className="size-9 rounded-lg" />
          </div>
          <label className="flex-1 text-xs text-white/60">
            Label
            <input value={label} onChange={(e) => setLabel(e.target.value)} className="mt-1 w-full rounded-lg bg-white/5 px-2.5 py-2 text-sm text-white outline-none ring-1 ring-white/10 focus:ring-[#c6ff1f]" />
          </label>
        </div>

        <div className="mb-2 text-xs text-white/60">Icon</div>
        <div className="mb-2 grid grid-cols-3 gap-1 rounded-lg bg-white/5 p-1">
          {([["domain", Globe, "Website"], ["url", Link2, "Image URL"], ["upload", Upload, "Upload"]] as const).map(([k, Icon, name]) => (
            <button key={k} type="button" onClick={() => setSource(k)} className={clsx("flex items-center justify-center gap-1.5 rounded-md py-1.5 text-xs", source === k ? "bg-white/15 text-white" : "text-white/60 hover:text-white")}>
              <Icon className="size-3.5" /> {name}
            </button>
          ))}
        </div>
        {source === "domain" && (
          <div className="flex gap-2">
            <input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="e.g. gimp.org" className="flex-1 rounded-lg bg-white/5 px-2.5 py-2 text-sm outline-none ring-1 ring-white/10 focus:ring-[#c6ff1f]" />
            <button type="button" onClick={() => domain.trim() && setIconUrl(favicon(domain.trim()))} className="rounded-lg bg-white/10 px-3 text-sm hover:bg-white/15">Fetch</button>
          </div>
        )}
        {source === "url" && (
          <div className="flex gap-2">
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…/icon.png" className="flex-1 rounded-lg bg-white/5 px-2.5 py-2 text-sm outline-none ring-1 ring-white/10 focus:ring-[#c6ff1f]" />
            <button type="button" onClick={() => url.trim() && setIconUrl(url.trim())} className="rounded-lg bg-white/10 px-3 text-sm hover:bg-white/15">Use</button>
          </div>
        )}
        {source === "upload" && (
          <>
            <input ref={file} type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
            <button type="button" disabled={busy} onClick={() => file.current?.click()} className="w-full rounded-lg border border-dashed border-white/20 py-3 text-sm text-white/70 hover:border-white/40 hover:text-white">
              {busy ? "Uploading…" : "Choose an image"}
            </button>
          </>
        )}

        <div className="mb-2 mt-4 text-xs text-white/60">Window color</div>
        <div className="flex flex-wrap items-center gap-1.5">
          {SWATCHES.map((c) => (
            <button key={c} type="button" onClick={() => setColor(c)} aria-label={c} className={clsx("size-6 rounded-full ring-offset-2 ring-offset-[#140d22]", color === c ? "ring-2 ring-white" : "ring-1 ring-white/15")} style={{ background: c }} />
          ))}
          <label className="relative size-6 cursor-pointer overflow-hidden rounded-full ring-1 ring-white/25" title="Custom color" style={{ background: "conic-gradient(red, yellow, lime, cyan, blue, magenta, red)" }}>
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="absolute inset-0 cursor-pointer opacity-0" />
          </label>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="rounded-lg px-3 py-2 text-sm text-white/70 hover:bg-white/10">Cancel</button>
          <button type="submit" className="rounded-lg bg-[#c6ff1f] px-4 py-2 text-sm font-semibold text-[#0a0614] hover:brightness-110">Save</button>
        </div>
      </motion.form>
    </div>
  );
}
