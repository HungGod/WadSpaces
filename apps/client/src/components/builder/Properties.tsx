import { Grid3x3, LayoutGrid, Lock, Power, Trash2, Users } from "lucide-react";
import clsx from "clsx";
import type { Layout, Visibility } from "@/lib/types";
import { WallpaperPicker } from "../WallpaperPicker";
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
        <WallpaperPicker value={layout.wallpaper} onChange={(wallpaper) => commit({ ...layout, wallpaper })} />
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
