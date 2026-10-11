// A wadspace's picture on cards and in the drawer: the desktop its layers
// give, on its own background, with its project folders.
import clsx from "clsx";
import { desktopFor, resolve, type Wadspace } from "@core/layers";
import { useApp } from "@/lib/store";
import { DesktopThumb } from "./desktop/DesktopThumb";

/** Drawn as on a smaller screen, so icons read at card size. */
const ZOOM = 1.6;

export function Thumb({ w, className, zoom = ZOOM }: { w: Wadspace; className?: string; zoom?: number }) {
  const templates = useApp((s) => s.templates);
  const customizations = useApp((s) => s.customizations);
  const projects = useApp((s) => s.projects);
  const r = resolve({ templates, customizations }, w.base);
  const mounted = w.projects.flatMap((id) => projects.find((p) => p.id === id) ?? []);
  return <DesktopThumb items={r ? desktopFor(r.template, r.setup, mounted) : []} wallpaper={w.wallpaper} zoom={zoom} className={clsx("aspect-video w-full", className)} />;
}
