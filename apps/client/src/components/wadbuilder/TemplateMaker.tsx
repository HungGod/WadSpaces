// Build your own template: the base image plus the apps you pick from the
// catalog, under a name no other template or customization has. Saving
// starts its image build.
import { useState } from "react";
import { Check, Info, Loader2 } from "lucide-react";
import clsx from "clsx";
import { APPS, appById, type AppDef } from "@core/catalog/catalog";
import { nameTaken, type Template } from "@core/layers";
import { useApp } from "@/lib/store";
import { Button, Input, Label, Modal, Textarea } from "../ui";
import { AppDetails } from "./AppDetails";

/** Build your own template: the base image plus the apps you pick. Saving builds its image. */
export function TemplateMaker({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: (t: Template) => void }) {
  const [apps, setApps] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [details, setDetails] = useState<AppDef | null>(null);
  const [saving, setSaving] = useState(false);
  const saveTemplate = useApp((s) => s.saveTemplate);
  const build = useApp((s) => s.build);
  const templates = useApp((s) => s.templates);
  const customizations = useApp((s) => s.customizations);
  const taken = !!name.trim() && nameTaken(name, { templates, customizations });

  const toggle = (id: string) => setApps((a) => (a.includes(id) ? a.filter((x) => x !== id) : [...a, id]));
  const save = async () => {
    setSaving(true);
    try {
      const t = await saveTemplate({ name: name.trim(), description: description.trim(), apps });
      void build(`template:${t.id}`);
      setApps([]);
      setName("");
      setDescription("");
      onSaved(t);
    } catch (e) {
      useApp.getState().toast({ title: "Couldn't save the template", body: (e as Error).message, tone: "error" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} width={820} title="Build your own template" subtitle="The base image (linuxserver.io's Debian, with WadSpaces' desktop) plus the apps you pick. Click an app to see what it is.">
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
        {APPS.map((a) => {
          const on = apps.includes(a.id);
          return (
            <div key={a.id} className={clsx("relative flex flex-col items-center gap-1.5 rounded-2xl p-3 text-center ring-1 transition-all", on ? "bg-accent-soft ring-2 ring-accent" : "bg-surface-2 ring-line hover:ring-line-strong")}>
              <button type="button" onClick={() => setDetails(a)} className="absolute inset-0 rounded-2xl" aria-label={`About ${a.name}`} />
              <img src={a.icon} alt="" className="size-10 object-contain" />
              <span className="text-[13px] font-medium">{a.name}</span>
              <span className="line-clamp-2 text-[11px] text-muted">{a.summary}</span>
              <button
                type="button"
                onClick={() => toggle(a.id)}
                aria-label={on ? `Remove ${a.name}` : `Add ${a.name}`}
                className={clsx("absolute right-2 top-2 z-10 grid size-6 place-items-center rounded-full", on ? "bg-accent text-accent-fg" : "bg-surface text-muted ring-1 ring-line-strong hover:text-fg")}
              >
                {on ? <Check className="size-3.5" strokeWidth={3} /> : <span className="text-base leading-none">+</span>}
              </button>
              <Info className="absolute left-2 top-2 size-3.5 text-faint" />
            </div>
          );
        })}
      </div>

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <div>
          <Label>Name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Pixel Art" aria-label="Template name" />
          {taken && <p className="mt-1 text-xs text-danger">&ldquo;{name.trim()}&rdquo; is taken: pick a new name</p>}
        </div>
        <div>
          <Label>Description</Label>
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="What it's for" />
        </div>
      </div>

      <div className="mt-5 flex items-center gap-3 border-t border-line pt-4">
        <span className="min-w-0 flex-1 truncate text-xs text-muted">{apps.length ? apps.map((id) => appById(id)?.name).join(" · ") : "No apps picked yet"}</span>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!apps.length || !name.trim() || taken || saving} onClick={() => void save()}>
          {saving && <Loader2 className="size-4 animate-spin" />} Save and build
        </Button>
      </div>

      <AppDetails app={details} onClose={() => setDetails(null)} added={!!details && apps.includes(details.id)} onToggle={details ? () => toggle(details.id) : undefined} />
    </Modal>
  );
}
