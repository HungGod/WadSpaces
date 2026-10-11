// Step 1: Choose your template. One stack per template: the template at the
// bottom, then the customizations built on it, then the wadspaces, the newest
// on top. Choosing a stack picks a starting point in it, and every start
// begins in Step 2, the template customization; a wadspace can also be opened
// (launched) or looked at from there. Recent builds are listed above, and
// what was deleted waits in "Recently deleted" below, to restore or delete
// for good.
import { useState } from "react";
import { ChevronDown, Copy, Hammer, Layers, Monitor, Pencil, Play, Plus, RotateCcw, Sparkles, Trash2 } from "lucide-react";
import clsx from "clsx";
import { appById, extensionById, toolById } from "@core/catalog/catalog";
import { desktopFor, emptySetup, imageKey, imageRef, stacks, type Customization, type DesktopItem, type LayerKey, type Setup, type Stack, type Template, type WadspaceV2 } from "@core/layers";
import { timeAgo } from "@/lib/format";
import { openWadspace } from "@/lib/launch";
import { useApp, type LayerKind } from "@/lib/store";
import { useTour } from "@/lib/tour";
import { useUi } from "@/lib/ui";
import type { Wallpaper } from "@/lib/types";
import { DesktopThumb } from "../desktop/DesktopThumb";
import { DEFAULT_WALLPAPER } from "../desktop/wallpapers";
import { Badge, Button, IconButton, Modal } from "../ui";
import { useDraft } from "./draft";
import { ImageBadge } from "./parts";
import { TemplateMaker } from "./TemplateMaker";

/** One card in a stack: what it is, and the desktop its image (or wadspace) shows. */
interface Card {
  key: string;
  kind: "Template" | "Customization" | "Wadspace";
  name: string;
  template: Template;
  setup: Setup;
  wallpaper: Wallpaper;
  projects: string[];
}

/** Bottom to top: the template, its customizations, then the wadspaces (oldest first, so the newest is on top). */
function cardsOf(s: Stack): Card[] {
  const t = s.template;
  const ws = [...s.wadspaces.map((w) => ({ w, setup: emptySetup(t.id) })), ...s.customizations.flatMap((c) => c.wadspaces.map((w) => ({ w, setup: c.customization as Setup })))].sort((a, b) =>
    a.w.updatedAt.localeCompare(b.w.updatedAt),
  );
  return [
    { key: `t:${t.id}`, kind: "Template", name: t.name, template: t, setup: emptySetup(t.id), wallpaper: DEFAULT_WALLPAPER, projects: [] },
    ...s.customizations.map(({ customization: c }) => ({ key: `c:${c.id}`, kind: "Customization" as const, name: c.name, template: t, setup: c as Setup, wallpaper: DEFAULT_WALLPAPER, projects: [] })),
    ...ws.map(({ w, setup }) => ({ key: `w:${w.id}`, kind: "Wadspace" as const, name: w.name, template: t, setup, wallpaper: w.wallpaper, projects: w.projects })),
  ];
}

/** Deletes softly, or says why it can't. */
async function removeIt(kind: LayerKind, id: string) {
  try {
    await useApp.getState().remove(kind, id);
  } catch (e) {
    useApp.getState().toast({ title: "Can't delete it yet", body: (e as Error).message, tone: "error" });
  }
}

export function StepTemplate() {
  const templates = useApp((s) => s.templates);
  const customizations = useApp((s) => s.customizations);
  const wadspaces = useApp((s) => s.wadspaces);
  const builds = useApp((s) => s.builds);
  const begin = useDraft((s) => s.begin);
  const signal = useTour((s) => s.signal);
  const [making, setMaking] = useState(false);
  const picking = useDraft((s) => s.picking);
  const setPicking = useDraft((s) => s.pick);
  const all = stacks({ templates, customizations, wadspaces });
  const recent = [...builds].filter((b) => b.layer).reverse().slice(0, 5);
  const picked = all.find((s) => s.template.id === picking);

  return (
    <div className="mx-auto max-w-6xl px-8 py-8" data-tour="step-template">
      <h1 className="font-display text-3xl font-bold tracking-tight">Choose your template</h1>
      <p className="mb-8 mt-1.5 text-sm text-muted">
        A template is the base image plus apps. On top of each are your customizations of it and the wadspaces built from them. Pick a stack, then where in it to start.
      </p>

      {recent.length > 0 && <RecentBuilds builds={recent} />}

      <section>
        <h2 className="font-display text-lg font-semibold tracking-tight">Templates</h2>
        <p className="mb-5 text-sm text-muted">Yours, and everything built on them.</p>
        <div className="grid gap-x-6 gap-y-8 md:grid-cols-2">
          {all.map((s, i) => (
            <TemplateStack
              key={s.template.id}
              stack={s}
              tour={i === 0}
              onOpen={() => {
                signal("stack-opened");
                openStack(s);
              }}
            />
          ))}
          <button
            type="button"
            onClick={() => setMaking(true)}
            className="flex aspect-[16/10] flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-line-strong text-muted transition-colors hover:border-accent/60 hover:text-fg"
          >
            <Plus className="size-7" />
            <span className="text-sm font-semibold">Build your own template</span>
            <span className="text-xs">The base image plus the apps you pick</span>
          </button>
        </div>
      </section>

      <RecentlyDeleted />

      <StartPicker stack={picked} onClose={() => setPicking(null)} />
      <TemplateMaker
        open={making}
        onClose={() => setMaking(false)}
        onSaved={(t) => {
          setMaking(false);
          signal("stack-opened");
          begin({ kind: "template", id: t.id }, { templates: useApp.getState().templates, customizations });
        }}
      />
    </div>
  );
}

/** The last few layer builds; each opens its log (the sidebar's). */
function RecentBuilds({ builds }: { builds: ReturnType<typeof useApp.getState>["builds"] }) {
  const setBuildLog = useApp((s) => s.setBuildLog);
  return (
    <section className="mb-10">
      <h2 className="mb-3 font-display text-lg font-semibold tracking-tight">Builds</h2>
      <div className="space-y-2">
        {builds.map((b) => (
          <button key={b.id} type="button" onClick={() => setBuildLog(b.id)} className="flex w-full items-center gap-3 rounded-2xl border border-line bg-surface/70 px-4 py-2.5 text-left hover:border-line-strong">
            <Hammer className="size-4 shrink-0 text-muted" />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2 text-sm font-medium">
                <span className="truncate">{b.name}</span>
                <span className="truncate font-mono text-[11px] text-faint">{imageRef(b.layer as LayerKey)}</span>
              </span>
            </span>
            {b.status === "building" ? <Badge tone="accent">{Math.round(b.progress * 100)}%</Badge> : b.status === "done" ? <Badge>Built</Badge> : <Badge tone="accent-2">{b.error ?? "Failed"}</Badge>}
            <span className="text-xs text-muted">Log</span>
          </button>
        ))}
      </div>
    </section>
  );
}

const OFFSET = 30;
/** Mock images are drawn as on a smaller screen, so their icons read at card size. */
const ZOOM = 1.6;

/** Opens a stack: its picker, or straight into Step 2 when there's nothing on the template yet. */
export function openStack(s: Stack) {
  const { templates, customizations } = useApp.getState();
  const lone = !s.customizations.length && !s.wadspaces.length;
  if (lone) useDraft.getState().begin({ kind: "template", id: s.template.id }, { templates, customizations });
  else useDraft.getState().pick(s.template.id);
}

/** A template and what's built on it, as a pile of cards: the newest wadspace on top, the template's edge at the back. */
export function TemplateStack({ stack, onOpen, tour }: { stack: Stack; onOpen: () => void; tour?: boolean }) {
  const projects = useApp((s) => s.projects);
  const cards = cardsOf(stack);
  const shown = cards.slice(-4);
  const depth = shown.length - 1;
  const t = stack.template;
  const nC = stack.customizations.length;
  const nW = stack.wadspaces.length + stack.customizations.reduce((n, c) => n + c.wadspaces.length, 0);
  const counts = [nC && `${nC} customization${nC === 1 ? "" : "s"}`, nW && `${nW} wadspace${nW === 1 ? "" : "s"}`].filter(Boolean).join(" · ");

  return (
    <button type="button" onClick={onOpen} aria-label={`Start from ${t.name}`} className="group block text-left" data-tour={tour ? "stack" : undefined}>
      <div className="relative" style={{ paddingTop: depth * OFFSET, paddingLeft: depth * OFFSET }}>
        {shown.map((l, i) => {
          const down = depth - i; // how far below the top card
          const mounted = l.projects.flatMap((id) => projects.find((p) => p.id === id) ?? []);
          return (
            <div
              key={l.key}
              className={clsx("overflow-hidden rounded-2xl shadow-deep ring-1 ring-line-strong transition-transform duration-200", i === depth ? "relative" : "absolute", down > 0 && "group-hover:[transform:var(--fan)]")}
              style={
                {
                  zIndex: i,
                  // Same size as the top card, sitting `down` steps up and to the left of it.
                  ...(i < depth && { top: (depth - down) * OFFSET, left: (depth - down) * OFFSET, right: down * OFFSET, bottom: down * OFFSET }),
                  "--fan": `translate(${-down * 10}px, ${-down * 10}px) rotate(${-down * 1.5}deg)`,
                } as React.CSSProperties
              }
            >
              <DesktopThumb items={desktopFor(l.template, l.setup, mounted)} wallpaper={l.wallpaper} zoom={ZOOM} className="aspect-[16/9] w-full" />
              <span className="absolute left-1.5 top-1">
                <Badge tone="glass">
                  {l.kind === "Template" ? <Layers className="size-3" /> : l.kind === "Customization" ? <Plus className="size-3" /> : <Monitor className="size-3" />}
                  {i === depth ? `${l.kind} · ${l.name}` : l.name}
                </Badge>
              </span>
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-base font-semibold">{t.name}</span>
            {t.starter && (
              <Badge>
                <Sparkles className="size-3" /> Starter
              </Badge>
            )}
          </div>
          <p className="mt-0.5 line-clamp-1 text-xs text-muted">
            {t.apps.map((a) => appById(a)?.name).join(", ")}
            {counts && ` · ${counts}`}
          </p>
        </div>
        <ImageBadge image={`template:${t.id}`} />
      </div>
    </button>
  );
}

/** "Claude Code, Firebase CLI, 7 web apps": what a customization adds. */
export function customizationSummary(c: Setup) {
  const bits = [...c.extensions.map((e) => extensionById(e).name), ...c.tools.map((id) => toolById(id)?.name ?? id)];
  if (c.webapps.length) bits.push(`${c.webapps.length} web app${c.webapps.length === 1 ? "" : "s"}`);
  if (c.browserMode === "focus") bits.push("WadBrowser Focus");
  return bits.join(", ") || "Nothing added yet";
}

/** Where in a stack to start: the template, one of its customizations, or a wadspace (to open, edit, or start a new one from). */
function StartPicker({ stack, onClose }: { stack?: Stack; onClose: () => void }) {
  const templates = useApp((s) => s.templates);
  const customizations = useApp((s) => s.customizations);
  const draft = useDraft();
  const lib = { templates, customizations };
  const go = (fn: () => void) => {
    fn();
    onClose();
  };
  if (!stack)
    return (
      <Modal open={false} onClose={onClose}>
        {null}
      </Modal>
    );
  const t = stack.template;
  const wadspaceRow = (w: WadspaceV2, depth: number, setup: Setup) => (
    <WadspaceRow key={w.id} w={w} depth={depth} setup={setup} template={t} onEdit={() => go(() => draft.edit(w, lib))} onCopy={() => go(() => draft.copy(w, lib))} onDone={onClose} />
  );
  return (
    <Modal open onClose={onClose} width={820} title={`Start from ${t.name}`} subtitle="Pick a starting point. Every start opens on Step 2, the template customization; changes are saved under a new name.">
      <div className="max-h-[62vh] space-y-2 overflow-y-auto pr-1">
        <Row depth={0} kind="Template" name={t.name} detail={t.apps.map((a) => appById(a)?.name).join(", ")} items={desktopFor(t, emptySetup(t.id))} wallpaper={DEFAULT_WALLPAPER} image={`template:${t.id}`}>
          <IconButton label={`Delete ${t.name}`} onClick={() => confirm(`Delete the ${t.name} template?`) && void removeIt("template", t.id)}>
            <Trash2 className="size-4" />
          </IconButton>
          <Button size="sm" variant="primary" onClick={() => go(() => draft.begin({ kind: "template", id: t.id }, lib))}>
            Start here
          </Button>
        </Row>
        {stack.wadspaces.map((w) => wadspaceRow(w, 1, emptySetup(t.id)))}
        {stack.customizations.map(({ customization: c, wadspaces }) => (
          <div key={c.id} className="space-y-2">
            <Row depth={1} kind="Customization" name={c.name} detail={customizationSummary(c)} items={desktopFor(t, c)} wallpaper={DEFAULT_WALLPAPER} image={`custom:${c.id}`}>
              <IconButton label={`Delete ${c.name}`} onClick={() => confirm(`Delete ${c.name}?`) && void removeIt("customization", c.id)}>
                <Trash2 className="size-4" />
              </IconButton>
              <Button size="sm" variant="primary" onClick={() => go(() => draft.begin({ kind: "customization", id: c.id }, lib))}>
                Start here
              </Button>
            </Row>
            {wadspaces.map((w) => wadspaceRow(w, 2, c))}
          </div>
        ))}
      </div>
    </Modal>
  );
}

function Row({ depth, kind, name, detail, items, wallpaper, image, onDetails, children }: { depth: number; kind: string; name: string; detail: string; items: DesktopItem[]; wallpaper: Wallpaper; image: LayerKey; onDetails?: () => void; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 rounded-2xl bg-surface-2/60 p-2.5 ring-1 ring-line" style={{ marginLeft: depth * 28 }}>
      <DesktopThumb items={items} wallpaper={wallpaper} zoom={ZOOM * 1.4} className="aspect-video w-52 shrink-0 rounded-xl ring-1 ring-line" />
      <div className="min-w-0 flex-1">
        <div className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-faint">{kind}</div>
        {onDetails ? (
          <button type="button" onClick={onDetails} className="block max-w-full truncate text-left text-sm font-semibold hover:underline" title="Details">
            {name}
          </button>
        ) : (
          <div className="truncate text-sm font-semibold">{name}</div>
        )}
        <div className="truncate text-xs text-muted">{detail}</div>
        <div className="mt-1">
          <ImageBadge image={image} />
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">{children}</div>
    </div>
  );
}

function WadspaceRow({ w, depth, setup, template, onEdit, onCopy, onDone }: { w: WadspaceV2; depth: number; setup: Setup; template: Template; onEdit: () => void; onCopy: () => void; onDone: () => void }) {
  const projects = useApp((s) => s.projects);
  const openDetails = useUi((s) => s.openDetails);
  const mounted = w.projects.flatMap((id) => projects.find((p) => p.id === id) ?? []);
  return (
    <Row
      depth={depth}
      kind="Wadspace"
      name={w.name}
      detail={`Saved ${timeAgo(w.updatedAt)}${mounted.length ? ` · ${mounted.map((p) => p.name).join(", ")}` : ""}`}
      items={desktopFor(template, setup, mounted)}
      wallpaper={w.wallpaper}
      image={imageKey(w.base)}
      onDetails={() => {
        onDone();
        openDetails(w.id);
      }}
    >
      <IconButton label={`Delete ${w.name}`} onClick={() => confirm(`Delete ${w.name}?`) && void removeIt("wadspace", w.id)}>
        <Trash2 className="size-4" />
      </IconButton>
      <Button size="sm" variant="ghost" onClick={onCopy} title="A new wadspace with its background, projects and secrets">
        <Copy className="size-3.5" /> New from it
      </Button>
      <Button size="sm" variant="ghost" onClick={onEdit} aria-label={`Edit ${w.name}`}>
        <Pencil className="size-3.5" /> Edit
      </Button>
      <Button
        size="sm"
        variant="primary"
        onClick={() => {
          onDone();
          void openWadspace(w);
        }}
        aria-label={`Open ${w.name}`}
      >
        <Play className="size-3.5 fill-current" /> Open
      </Button>
    </Row>
  );
}

type Deleted = { kind: LayerKind; label: string; id: string; name: string; deletedAt: string };

/** What was deleted: restore it, or delete it for good (refused while anything is built on it). */
function RecentlyDeleted() {
  const templates = useApp((s) => s.templates);
  const customizations = useApp((s) => s.customizations);
  const wadspaces = useApp((s) => s.wadspaces);
  const browsers = useApp((s) => s.browsers);
  const restore = useApp((s) => s.restore);
  const purge = useApp((s) => s.purge);
  const toast = useApp((s) => s.toast);
  const [open, setOpen] = useState(false);
  const gone = (list: { id: string; name: string; deletedAt?: string }[], kind: LayerKind, label: string): Deleted[] =>
    list.filter((x) => x.deletedAt).map((x) => ({ kind, label, id: x.id, name: x.name, deletedAt: x.deletedAt! }));
  const items = [
    ...gone(wadspaces, "wadspace", "Wadspace"),
    ...gone(customizations as Customization[], "customization", "Customization"),
    ...gone(templates, "template", "Template"),
    ...gone(browsers, "browser", "WadBrowser setup"),
  ].sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
  if (!items.length) return null;
  const run = (fn: () => Promise<void>, what: string) => () =>
    void fn().catch((e) => toast({ title: `Couldn't ${what}`, body: (e as Error).message, tone: "error" }));
  return (
    <section className="mt-12 border-t border-line pt-5">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex items-center gap-2 text-sm font-semibold text-muted hover:text-fg">
        <ChevronDown className={clsx("size-4 transition-transform", !open && "-rotate-90")} /> Recently deleted ({items.length})
      </button>
      {open && (
        <div className="mt-3 space-y-1.5">
          {items.map((d) => (
            <div key={`${d.kind}:${d.id}`} className="flex items-center gap-3 rounded-2xl bg-surface-2/60 px-3 py-2 ring-1 ring-line">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{d.name}</span>
                <span className="block text-xs text-muted">
                  {d.label} · deleted {timeAgo(d.deletedAt)}
                </span>
              </span>
              <Button size="sm" variant="ghost" onClick={run(() => restore(d.kind, d.id), "restore it")}>
                <RotateCcw className="size-3.5" /> Restore
              </Button>
              <Button size="sm" variant="ghost" onClick={() => confirm(`Delete ${d.name} for good? This can't be undone.`) && run(() => purge(d.kind, d.id), "delete it")()}>
                <Trash2 className="size-3.5" /> Delete for good
              </Button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
