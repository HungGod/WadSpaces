// The right-hand pane in Steps 2 and 3: the wadspace's desktop as the image
// will show it, live, or its image layers: base, template, customization, and
// what's mounted at start.
import { useLayoutEffect, useState } from "react";
import { FileCode2, LayoutDashboard } from "lucide-react";
import { customizationDockerfile, desktopFor, imageRef, resolve, runSummary, sameSetup, slotsFor, startMenuFor, templateDockerfile, type Customization, type LayerKey } from "@core/layers";
import { DEFAULT_BASE_IMAGE } from "@core/spec";
import { useApp } from "@/lib/store";
import { Desktop } from "../desktop/Desktop";
import { useScreen } from "../desktop/look";
import { Badge, Segmented } from "../ui";
import { resolvedName, useDraft } from "./draft";
import { BuildButton, ImageBadge } from "./parts";

export function Preview() {
  const [view, setView] = useState<"desktop" | "image">("desktop");
  const base = useDraft((s) => s.base);
  const setup = useDraft((s) => s.setup);
  const w = useDraft((s) => s.wadspace);
  const step = useDraft((s) => s.step);
  const templates = useApp((s) => s.templates);
  const customizations = useApp((s) => s.customizations);
  const projects = useApp((s) => s.projects);
  const screen = useScreen();
  // The pane, once it's there (the first render can come before the layers
  // load): the desktop is fitted to it.
  const [pane, setPane] = useState<HTMLDivElement | null>(null);
  const [fit, setFit] = useState({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const el = pane;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const pw = e.contentRect.width - 48;
      const ph = e.contentRect.height - 48;
      const aspect = screen.w / screen.h;
      const width = Math.max(240, Math.min(pw, ph * aspect));
      setFit({ w: Math.floor(width), h: Math.floor(width / aspect) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [pane, screen.w, screen.h]);

  const r = base && resolve({ templates, customizations }, base);
  if (!r || !setup) return null;
  const mounted = step === "construct" ? w.projects.flatMap((id) => projects.find((p) => p.id === id) ?? []) : [];
  const items = desktopFor(r.template, setup, mounted);
  const menu = startMenuFor(r.template, setup);

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-[radial-gradient(var(--line)_1px,transparent_1px)] [background-size:18px_18px]" data-tour="preview">
      <div className="flex items-center gap-3 px-6 pt-4 text-xs text-muted">
        <Segmented
          value={view}
          onChange={setView}
          options={[
            { value: "desktop", label: <><LayoutDashboard className="size-3.5" /> Desktop</> },
            { value: "image", label: <><FileCode2 className="size-3.5" /> Image</> },
          ]}
        />
        <span>{view === "desktop" ? "Live: double-click icons, try the Start button" : "The layers it's built from"}</span>
        {view === "desktop" && <span className="ml-auto font-mono text-faint">{screen.w}×{screen.h}</span>}
      </div>
      <div ref={setPane} className="relative min-h-0 flex-1 overflow-auto">
        {view === "desktop" ? (
          fit.w > 0 && (
            <div className="grid h-full place-items-center">
              <div className="rounded-[18px] p-1.5 shadow-deep ring-1 ring-line-strong" style={{ background: "linear-gradient(180deg, var(--surface-3), var(--surface))" }}>
                {/* A new key per setup: the boot apps open again when they change. */}
                <Desktop key={JSON.stringify(setup.autostart)} items={items} menu={menu} wallpaper={w.wallpaper} autostart={setup.autostart} className="rounded-xl" style={{ width: fit.w, height: fit.h }} />
              </div>
            </div>
          )
        ) : (
          <Layers />
        )}
      </div>
    </div>
  );
}

function Layers() {
  const base = useDraft((s) => s.base);
  const setup = useDraft((s) => s.setup);
  const w = useDraft((s) => s.wadspace);
  const templates = useApp((s) => s.templates);
  const customizations = useApp((s) => s.customizations);
  const projects = useApp((s) => s.projects);
  const r = base && resolve({ templates, customizations }, base);
  if (!r || !setup) return null;
  const changed = !sameSetup(setup, r.setup);
  // What the customization's Dockerfile would be with this draft's setup (saved or not).
  const custom: Customization | null =
    r.customization || setup.webapps.length || setup.extensions.length || setup.tools.length || setup.autostart.length || setup.browserMode !== "browser"
      ? { ...(r.customization ?? { id: "unsaved", owner: "", name: "Unsaved customization", description: "", createdAt: "", updatedAt: "" }), ...setup }
      : null;
  const slots = slotsFor(r.template, setup);
  // Grouped by name here: new ones have no id until they're saved.
  const secrets = Object.fromEntries(slots.flatMap((s) => (resolvedName(w, s) ? [[s.key, { id: resolvedName(w, s)!.toLowerCase(), name: resolvedName(w, s)!, kind: s.kind }]] : [])));

  return (
    <div className="mx-auto max-w-3xl space-y-4 px-6 py-5">
      <Layer title="Base" subtitle={DEFAULT_BASE_IMAGE} note="linuxserver/baseimage-debian:trixie with WadSpaces' desktop: labwc, selkies-desktop, WadBrowser, foot." />
      <Layer title={`Template: ${r.template.name}`} image={`template:${r.template.id}`} dockerfile={templateDockerfile(r.template)} />
      {custom && (
        <Layer
          title={`Customization: ${custom.name}`}
          image={r.customization && !changed ? `custom:${r.customization.id}` : undefined}
          subtitle={r.customization && !changed ? undefined : "Not saved yet: save Step 2 to build it"}
          dockerfile={customizationDockerfile(custom, r.template)}
        />
      )}
      <div className="rounded-2xl border border-dashed border-line-strong bg-surface/60 p-4">
        <div className="text-sm font-semibold">Wadspace{w.name ? `: ${w.name}` : ""}</div>
        <div className="text-xs text-muted">No image of its own: wadd mounts these when it starts</div>
        <pre className="mt-3 overflow-x-auto rounded-lg bg-bg px-3 py-2 font-mono text-[11.5px] leading-relaxed text-muted ring-1 ring-line">{runSummary({ wallpaper: w.wallpaper, projects: w.projects, secrets }, projects, slots).join("\n")}</pre>
      </div>
    </div>
  );
}

function Layer({ title, subtitle, note, image, dockerfile }: { title: string; subtitle?: string; note?: string; image?: LayerKey; dockerfile?: string }) {
  const last = useApp((s) => (image ? [...s.builds].reverse().find((b) => b.layer === image) : undefined));
  return (
    <div className="rounded-2xl border border-line bg-surface/70 p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">{title}</div>
          <div className="truncate font-mono text-[11px] text-faint">{subtitle ?? (image ? imageRef(image) : "")}</div>
        </div>
        {image ? (
          <>
            <ImageBadge image={image} />
            <BuildButton image={image} />
          </>
        ) : (
          !dockerfile && <Badge>Comes with the machine</Badge>
        )}
      </div>
      {note && <p className="mt-2 text-xs text-muted">{note}</p>}
      {dockerfile && <pre className="mt-3 max-h-72 overflow-auto rounded-lg bg-bg px-3 py-2 font-mono text-[11.5px] leading-relaxed text-muted ring-1 ring-line">{dockerfile}</pre>}
      {last?.status === "building" && <pre className="mt-2 max-h-32 overflow-auto rounded-lg bg-bg px-3 py-2 font-mono text-[11px] text-faint ring-1 ring-line">{last.lines.slice(-6).join("\n")}</pre>}
    </div>
  );
}
