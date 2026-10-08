import { useState } from "react";
import { Hammer, Loader2, Save } from "lucide-react";
import { backend } from "@/data";
import { startBuild } from "@/lib/build";
import { useApp } from "@/lib/store";
import { useUi } from "@/lib/ui";
import type { Wadspace, Wallpaper } from "@/lib/types";
import { DesktopThumb } from "./desktop/DesktopThumb";
import { WallpaperPicker } from "./WallpaperPicker";
import { Button, Input, Label, Modal, Textarea } from "./ui";

/** A wadspace's name, description and background, without the Builder. */
export function EditWadspaceDialog() {
  const editId = useUi((s) => s.editId);
  const closeEdit = useUi((s) => s.openEdit);
  const ws = useApp((s) => s.wadspaces.find((w) => w.id === editId));
  return (
    <Modal open={!!ws} onClose={() => closeEdit(null)} width={820} title={ws && `Edit ${ws.name}`} subtitle="Its name, description and background. Apps and settings are in the Builder.">
      {ws && <Form key={ws.id} ws={ws} onClose={() => closeEdit(null)} />}
    </Modal>
  );
}

function Form({ ws, onClose }: { ws: Wadspace; onClose: () => void }) {
  const patchWadspace = useApp((s) => s.patchWadspace);
  const toast = useApp((s) => s.toast);
  const [name, setName] = useState(ws.name);
  const [description, setDescription] = useState(ws.description);
  const [wallpaper, setWallpaper] = useState<Wallpaper>(ws.layout.wallpaper);
  const [busy, setBusy] = useState<"save" | "build" | null>(null);

  const newBackground = wallpaper.type !== ws.layout.wallpaper.type || wallpaper.value !== ws.layout.wallpaper.value;
  const dirty = name.trim() !== ws.name || description.trim() !== ws.description || newBackground;
  // The background is in the image: an installed one shows it after a build.
  const rebuild = newBackground && !!ws.installed;
  const canBuild = backend.caps.localBuild && !!backend.startBuild;

  const save = async (build: boolean) => {
    if (!name.trim()) return;
    setBusy(build ? "build" : "save");
    try {
      await patchWadspace(ws.id, {
        name: name.trim(),
        description: description.trim(),
        ...(newBackground && { layout: { ...ws.layout, wallpaper } }),
      });
      if (build) await startBuild({ wadspaceId: ws.id, name: name.trim(), rebuild: true });
      else toast({ title: "Saved", body: name.trim(), tone: "success" });
      onClose();
    } catch (e) {
      toast({ title: "Couldn't save", body: (e as Error).message, tone: "error" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="grid gap-6 md:grid-cols-[1fr_320px]">
      <div className="min-w-0 space-y-4">
        <DesktopThumb layout={{ ...ws.layout, wallpaper }} className="aspect-video w-full overflow-hidden rounded-2xl ring-1 ring-line" />
        <div>
          <Label>Name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name your wadspace" autoFocus />
        </div>
        <div>
          <Label>Description</Label>
          <Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What's this wadspace for?" />
        </div>
      </div>

      <div className="min-w-0">
        <Label>Background</Label>
        <WallpaperPicker value={wallpaper} onChange={setWallpaper} />
        {rebuild && (
          <p className="mt-3 rounded-xl bg-accent-2-soft px-3 py-2 text-xs ring-1 ring-accent-2/40">
            The new background shows once {ws.name} is rebuilt{canBuild ? "." : " on its machine."}
          </p>
        )}
      </div>

      <div className="flex flex-wrap justify-end gap-2 md:col-span-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        {rebuild && canBuild ? (
          <>
            <Button onClick={() => save(false)} disabled={!!busy || !name.trim()}>
              {busy === "save" ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} Save
            </Button>
            <Button variant="primary" onClick={() => save(true)} disabled={!!busy || !name.trim()}>
              {busy === "build" ? <Loader2 className="size-4 animate-spin" /> : <Hammer className="size-4" />} Save and rebuild
            </Button>
          </>
        ) : (
          <Button variant="primary" onClick={() => save(false)} disabled={!!busy || !dirty || !name.trim()}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} Save
          </Button>
        )}
      </div>
    </div>
  );
}
