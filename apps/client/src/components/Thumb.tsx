// A wadspace's picture on cards and in the drawer: the desktop its layers
// give, on its own background, with its projects' folders.
import clsx from "clsx";
import { desktopFor, resolveStack, type Wadspace } from "@core/layers";
import { BLANK_WALLPAPER } from "./desktop/wallpapers";
import { useApp } from "@/lib/store";
import { DesktopThumb } from "./desktop/DesktopThumb";

/** Drawn as on a smaller screen, so icons read at card size. */
const ZOOM = 1.6;

export function Thumb({ w, className, zoom = ZOOM }: { w: Wadspace; className?: string; zoom?: number }) {
  const templates = useApp((s) => s.templates);
  const extensions = useApp((s) => s.extensions);
  const r = resolveStack({ templates, extensions }, w);
  const projects = (w.customization?.projects ?? []).map((p) => ({ id: p.id, name: p.as }));
  return <DesktopThumb items={r ? desktopFor(r.template, r.setup, projects) : []} wallpaper={w.customization?.wallpaper ?? BLANK_WALLPAPER} zoom={zoom} className={clsx("aspect-video w-full", className)} />;
}
