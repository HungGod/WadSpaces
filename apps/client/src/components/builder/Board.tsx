// The board: every wadspace as a stack of modules (top layer first, templates
// at the bottom) in one row stepped through with arrows. New wadspaces come
// from existing ones: dragging modules and holding between two stacks opens a
// gap to start a new stack there.
//
// Dropping modules on a stack, into a gap or onto a template always copies
// them; Build and Delete act on the originals. Right-click mid-drag cancels.
// Delete runs along the bottom: drop a module on it, or Ctrl+click modules to
// select them and press it.
// Deleting a whole stack asks first.
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, ChevronLeft, ChevronRight, Eye, Hammer, Plus, RefreshCw, Trash2, Undo2, Wrench, X } from "lucide-react";
import { app, problemsOf, subFits } from "./catalog";
import { BLANK_WALLPAPER, LAYER_INFO, appsOf, lookOf, fitTemplates, moduleName, modulesOf, stackName, statusOf, uid, type AnySub, type AppSub, type AppSubKey, type CustomSub, type Layer, type Module, type Stack, type TemplateModule } from "./model";
import { NEW, buildStateOf, grab, isBuilding, nameClash, unbuiltOf, updatesOf, useBoard, useImages, type ModuleSource } from "./store";
import { useDraggable, useDropTarget, useDrag, type Payload } from "./drag";
import { AppSubWindow, BlankCustomization, BlankExtensions, BlankWindow, ChipFace, PromptFace, type Prompt, LAYER_ICON, ModuleFace, Pile, TrayFace, subSummary } from "./faces";

type Rect = { x: number; y: number; w: number; h: number };
const rectOf = (el: Element | null): Rect => {
  const r = el?.getBoundingClientRect();
  return r ? { x: r.left, y: r.top, w: r.width, h: r.height } : { x: innerWidth / 2 - 140, y: innerHeight / 2 - 100, w: 280, h: 200 };
};

/** A stack holding just these modules, for drawing modules that aren't on the board. */
const stackOf = (modules: Module[]): Stack => ({
  id: "ghost",
  templates: modules.filter((m): m is TemplateModule => m.layer === "template"),
  extensions: modules.find((m) => m.layer === "extensions") as Stack["extensions"],
  customization: modules.find((m) => m.layer === "customization") as Stack["customization"],
});

/** What dropping modules does: deleted ones are restored, others copied. */
const verb = (from: ModuleSource) => (from.kind === "deleted" ? "Restore" : "Copy");

const modulesLabel = (ms: Module[]) => (ms.length === 1 ? LAYER_INFO[ms[0].layer].label : `${ms.length} modules`);

/** Ctrl+click (⌘+click on a Mac) selects modules, for Build and Delete. */
const selecting = (e: React.MouseEvent) => e.ctrlKey || e.metaKey;

const dropClass = (d: { over: { ok: boolean } | null; could: boolean }) => (d.over ? (d.over.ok ? " drop-ok" : " drop-no") : d.could ? " drop-could" : "");

/** An empty module to set up in its editor. */
function blank(layer: Layer): Module {
  const id = uid("new");
  if (layer === "template") return { layer, id, name: "New template", description: "", apps: [] };
  if (layer === "extensions") return { layer, id, name: "New extensions", subs: [] };
  return { layer, id, subs: [{ key: "look", id: uid("look"), origin: "", name: "", description: "", wallpaper: BLANK_WALLPAPER }] };
}

/** Opens the editor on a new module for a stack that lacks that layer. */
const add = (layer: Layer, stackId: string, from: Rect, focus?: string) => {
  const { stacks, openEditor } = useBoard.getState();
  const fresh = blank(layer);
  // Names are unique per kind, so a new module starts with a free one.
  const stack = stacks.find((st) => st.id === stackId);
  const free = (base: string, taken: string[]) => {
    let name = base;
    for (let n = 1; taken.includes(name.toLowerCase()); n++) name = `${base} - ${n}`;
    return name;
  };
  if (fresh.layer === "extensions") fresh.name = free(`${stack ? stackName(stack) : "New"} Extensions`, stacks.map((st) => st.extensions?.name.toLowerCase() ?? ""));
  if (fresh.layer === "template") fresh.name = free("New template", stacks.flatMap((st) => st.templates.map((t) => t.name.toLowerCase())));
  openEditor({ stackId, moduleId: fresh.id, layer, fresh, focus, from });
};

// ─────────────────────────────── stacks ───────────────────────────────

/** The stacks in one row. Arrows step through them a wadspace at a time; nothing else scrolls it (but a drag held at an edge). */
export function Stacks() {
  const stacks = useBoard((s) => s.stacks);
  const ref = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ start: true, end: true });
  const update = useCallback(() => {
    const el = ref.current;
    if (el) setEdge({ start: el.scrollLeft <= 2, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 2 });
  }, []);
  useEffect(() => {
    update();
    addEventListener("resize", update);
    return () => removeEventListener("resize", update);
  }, [update, stacks.length]);
  // A stack made with Create (or opened from elsewhere): bring it into view.
  const created = useBoard((s) => s.created);
  useEffect(() => {
    const el = ref.current;
    if (!el || !created) return;
    requestAnimationFrame(() => {
      const it = el.querySelector<HTMLElement>(`:scope > .stack[data-stack="${created}"]`);
      el.scrollTo({ left: it ? Math.max(0, it.offsetLeft - el.offsetLeft - 50) : el.scrollWidth, behavior: "smooth" });
    });
  }, [created]);
  const step = (dir: 1 | -1) => {
    const el = ref.current;
    if (!el) return;
    const lefts = [...el.querySelectorAll<HTMLElement>(":scope > .stack")].map((c) => c.offsetLeft - el.offsetLeft - 50);
    const to = dir > 0 ? lefts.find((x) => x > el.scrollLeft + 2) : [...lefts].reverse().find((x) => x < el.scrollLeft - 2);
    el.scrollTo({ left: Math.max(0, to ?? (dir > 0 ? el.scrollWidth : 0)), behavior: "smooth" });
  };
  return (
    <div className="stacks-wrap">
      <button className="stacks-nav prev" disabled={edge.start} onClick={() => step(-1)} title="Previous wadspace">
        <ChevronLeft size={20} />
      </button>
      <div ref={ref} className="stacks" data-autoscroll onScroll={update}>
        {stacks.length === 0 && <FirstWadspace />}
        {stacks.map((s, i) => [<Gap key={`gap-${s.id}`} at={i} />, <StackColumn key={s.id} stack={s} />])}
        <OpenSpace at={stacks.length} />
      </div>
      <button className="stacks-nav next" disabled={edge.end} onClick={() => step(1)} title="Next wadspace">
        <ChevronRight size={20} />
      </button>
    </div>
  );
}

/** An empty board (a new user): a stack to start the first wadspace from. Whatever's set up first makes it. */
function FirstWadspace() {
  const empty: Stack = { id: NEW, templates: [] };
  return (
    <div className="stack first-ws">
      <div className="first-intro">
        <div className="panel-title">Your first wadspace</div>
        <p className="rail-note">Set up any layer to start it: a template of apps, the extensions they come with, or its name, background and projects.</p>
      </div>
      <div className="stack-modules">
        <BlankCustomizationTile stack={empty} />
        <BlankExtensionsTile stack={empty} />
        <AddButton stack={empty} layer="template" />
      </div>
      <div className="stack-foot">
        <span className="stack-name faint">No wadspaces yet</span>
      </div>
    </div>
  );
}

/** A gap's drop of modules, starting a new stack at `at`. */
function useNewStackDrop(id: string, at: number, open: boolean) {
  const { newStack } = useBoard.getState();
  return useDropTarget(id, {
    accepts(p) {
      if (p.type !== "modules") return null;
      if (!open) return { ok: false, why: "Hold here to make room for a new stack" };
      return { ok: true, why: `${verb(p.from)} ${modulesLabel(p.modules)} into a new stack here` };
    },
    onDrop(p) {
      if (p.type === "modules") newStack(p.modules, p.from, at);
    },
  });
}

/**
 * The open board after the last stack: drop modules anywhere on it (no hold
 * needed) to start a new stack with copies of them, e.g. to clone a stack.
 */
function OpenSpace({ at }: { at: number }) {
  const { active } = useDrag();
  const drop = useNewStackDrop("open-space", at, true);
  const dragging = active?.payload.type === "modules";
  return (
    <div {...drop.props} className={`open-space${dragging ? " live" : ""}${drop.over?.ok ? " drop-ok" : ""}`}>
      {dragging && (
        <div className="open-slot">
          <Plus size={20} />
          <span>Drop to make a new stack here</span>
          <small>{active.payload.type === "modules" && active.payload.modules.length > 1 ? `With copies of these ${active.payload.modules.length} modules` : "With a copy of this module"}</small>
        </div>
      )}
    </div>
  );
}

/**
 * The space between two stacks. Hold a dragged module over it (it reaches a
 * little into both stacks, for some leeway) and it opens into a slot for a
 * new stack; it stays open a moment after the pointer slips off.
 */
function Gap({ at, last }: { at: number; last?: boolean }) {
  const { active, refresh } = useDrag();
  const [open, setOpen] = useState(false);
  const drop = useNewStackDrop(`gap:${at}`, at, open);
  const over = !!drop.over;
  const modules = active?.payload.type === "modules";
  useEffect(() => {
    if (!modules) return setOpen(false);
    const t = setTimeout(() => setOpen(over), over ? 320 : 450);
    return () => clearTimeout(t);
  }, [over, modules]);
  // Opening changes what a drop here does, though the pointer hasn't moved.
  useEffect(() => refresh(), [open, refresh]);
  return (
    <div className={`gap${open ? " open" : ""}${last ? " last" : ""}${modules ? " live" : ""}`}>
      <div {...drop.props} className={`gap-hit${drop.over?.ok ? " drop-ok" : ""}`}>
        {open && (
          <div className="gap-slot">
            <Plus size={18} />
            New stack here
          </div>
        )}
        {!open && over && <div className="gap-line" />}
      </div>
    </div>
  );
}

function Guide({ layer, note }: { layer: Layer; note?: string }) {
  return (
    <div className={`drop-guide guide-${layer} lit`}>
      {LAYER_ICON[layer]({ size: 14 })} {note ?? `${LAYER_INFO[layer].label} goes here`}
    </div>
  );
}

/** A stack's modules, top first; a layer it lacks gets a + button (or, while dragging, a guide where a drop would land). */
function StackModules({ stack }: { stack: Stack }) {
  const { active } = useDrag();
  const { canPlace } = useBoard.getState();
  const dragged = active?.payload.type === "modules" ? active.payload.modules : [];
  const from = active?.payload.type === "modules" ? active.payload.from : null;
  const fits = !!from && canPlace(dragged, stack.id, from).ok;
  // Dragging copies, so the originals stay put.
  const lifted: string[] = [];
  const guide = (l: Layer) => fits && dragged.some((m) => m.layer === l);
  const adding = dragged.filter((m): m is TemplateModule => m.layer === "template");
  const templateAt = guide("template") ? fitTemplates(stack.templates, adding, (id) => app(id)?.name ?? id) : null;

  const tile = (m: Module, compact?: boolean) => <ModuleTile key={m.id} stack={stack} module={m} lifted={lifted.includes(m.id)} compact={compact} />;
  // Only the top template is drawn in full; the ones it builds on fold into strips.
  const templates: React.ReactNode[] = stack.templates.map((t, i) => tile(t, i < stack.templates.length - 1));
  if (templateAt?.ok) templates.splice(templateAt.at, 0, <Guide key="guide-template" layer="template" />);
  else if (!stack.templates.length && !active) templates.push(<AddButton key="add-template" stack={stack} layer="template" />);

  const slot = (l: "customization" | "extensions") => {
    const m = stack[l];
    if (m) return tile(m);
    if (guide(l)) return <Guide key={`guide-${l}`} layer={l} />;
    // Not there yet: a blank block showing what it could have.
    if (l === "extensions") return <BlankExtensionsTile key="blank-extensions" stack={stack} />;
    return <BlankCustomizationTile key="blank-customization" stack={stack} />;
  };

  return (
    <div className="stack-modules">
      {slot("customization")}
      {slot("extensions")}
      {templates.reverse()}
    </div>
  );
}

/** A blank Extensions block: click it, or one of its blank windows, to set the stack's Extensions up. */
function BlankExtensionsTile({ stack }: { stack: Stack }) {
  const ref = useRef<HTMLDivElement>(null);
  const open = (focus?: string) => add("extensions", stack.id, rectOf(ref.current), focus);
  return (
    <div ref={ref} className="mod-tile blank" onClick={() => open()} title="Set up this wadspace's Extensions">
      <BlankExtensions stack={stack} blank={(k) => <BlankWin key={k} k={k} onOpen={() => open(k)} />} />
    </div>
  );
}

/** A blank Customization block: click it, or one of its prompts, to set the stack's Customization up. */
function BlankCustomizationTile({ stack }: { stack: Stack }) {
  const ref = useRef<HTMLDivElement>(null);
  const open = (focus?: string) => add("customization", stack.id, rectOf(ref.current), focus);
  return (
    <div ref={ref} className="mod-tile blank" onClick={() => open()} title="Set up this wadspace's Customization">
      <BlankCustomization stack={stack} prompt={(p) => <PromptButton key={p.label} p={p} onOpen={() => open(p.focus)} />} />
    </div>
  );
}

function PromptButton({ p, onOpen }: { p: Prompt; onOpen(): void }) {
  return (
    <span className="sub-grab blank-grab" onClick={(e) => !selecting(e) && (e.stopPropagation(), onOpen())}>
      <PromptFace p={p} />
    </span>
  );
}

function BlankWin({ k, onOpen }: { k: AppSubKey; onOpen(): void }) {
  return (
    <div className="sub-grab blank-grab" onClick={(e) => !selecting(e) && (e.stopPropagation(), onOpen())} title={`Set up ${k === "tools" ? "command-line tools" : k === "vscode" ? "VS Code" : "WadBrowser"}`}>
      <BlankWindow k={k} />
    </div>
  );
}

function AddButton({ stack, layer }: { stack: Stack; layer: Layer }) {
  const label = layer === "template" ? "Add a template" : layer === "extensions" ? "Add extensions" : "Add a customization";
  return (
    <button className={`add-btn slim add-${layer}`} onClick={(e) => add(layer, stack.id, rectOf(e.currentTarget))}>
      <Plus size={13} /> {label}
    </button>
  );
}

function StackColumn({ stack }: { stack: Stack }) {
  const { openPreview, canPlace, placeModules } = useBoard.getState();
  const drop = useDropTarget(`stack:${stack.id}`, {
    accepts(p) {
      if (p.type !== "modules") return null;
      const v = canPlace(p.modules, stack.id, p.from);
      if (!v.ok) return v;
      return { ok: true, why: `${verb(p.from)} ${modulesLabel(p.modules)} to ${stackName(stack)}${v.replaces ? ` (replaces ${v.replaces})` : ""}` };
    },
    onDrop(p) {
      if (p.type === "modules") placeModules(p.modules, p.from, stack.id);
    },
  });
  const status = statusOf(stack);
  const problems = problemsOf(stack);
  const fresh = useBoard((s) => s.created === stack.id);
  const [fixing, setFixing] = useState(false);
  useImages();
  const building = isBuilding(stack);
  const unbuilt = unbuiltOf(stack).length;
  const updates = updatesOf(stack).length;
  // Ready to deploy: everything built, and a named customization on top.
  const chip = problems.length
    ? { cls: "status-broken", text: "Needs fixing" }
    : status !== "ready"
      ? { cls: `status-${status}`, text: status === "no-template" ? "Needs a template" : "Needs a customization" }
      : building
        ? { cls: "status-building", text: "Building…" }
        : unbuilt
          ? { cls: "status-unbuilt", text: `Not built · ${unbuilt}` }
          : !lookOf(stack)?.name.trim()
            ? { cls: "status-no-customization", text: "Needs a name" }
            : updates
              ? { cls: "status-update", text: "Update available" }
              : { cls: "status-ready", text: "Ready" };
  return (
    <div {...drop.props} data-stack={stack.id} className={`stack${problems.length ? " broken" : ""}${fresh ? " fresh" : ""}${dropClass(drop)}`}>
      {problems.length > 0 && (
        <button className="broken-banner" onClick={() => setFixing(true)} title="See what's wrong and fix it">
          <AlertTriangle size={14} />
          <span>Incorrect configuration</span>
          <span className="broken-fix">Fix</span>
        </button>
      )}
      <StackModules stack={stack} />
      {fixing &&
        createPortal(
          <div className="wb">
            <FixDialog stack={stack} onClose={() => setFixing(false)} />
          </div>,
          document.body,
        )}
      <div className="stack-foot">
        <span className="stack-name">{stackName(stack)}</span>
        {chip.cls === "status-update" ? (
          <button
            className={`status ${chip.cls}`}
            onClick={() => useBoard.getState().buildStack(stack.id)}
            title={`A newer base (or a template under it) since ${updates === 1 ? "one of its images was" : `${updates} of its images were`} built. It runs as it is; click to build again on what's there now.`}
          >
            <RefreshCw size={11} /> {chip.text}
          </button>
        ) : (
          <span className={`status ${chip.cls}`} title={chip.cls === "status-ready" ? "Built and named: ready to deploy" : undefined}>
            {chip.text}
          </span>
        )}
        <button className="btn-preview icon" onClick={() => openPreview(stack.id)} title="Preview: see the finished wadspace (nothing is launched)" aria-label="Preview">
          <Eye size={14} />
        </button>
      </div>
    </div>
  );
}

function ModuleTile({ stack, module, lifted, compact }: { stack: Stack; module: Module; lifted: boolean; compact?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const { openEditor, canPlaceSub, placeSub, canPlace, canStart, newStack } = useBoard.getState();
  const layer = module.layer;
  // Dropped on one of this stack's templates, modules that can't join the stack start a new one beside it, on a copy of the template (and what it builds on).
  const base = layer === "template" ? stack.templates.slice(0, stack.templates.findIndex((t) => t.id === module.id) + 1) : [];
  const drag = useDraggable((e) => {
    // A drag takes this module and what's on top of it; Shift+drag just this module.
    const modules = grab(stack, module.id, e.shiftKey);
    return { payload: { type: "modules", modules, from: { kind: "stack", stackId: stack.id } }, ghost: <Pile stack={stack} modules={modules} /> };
  });
  // Submodules drop into their module.
  const drop = useDropTarget(`module:${module.id}`, {
    accepts(p) {
      if (p.type === "modules") {
        if (layer !== "template" || (p.from.kind === "stack" && p.from.stackId === stack.id)) return null;
        // The stack takes them as they are: that drop wins.
        // Only when the stack would have to replace something: else the stack takes them.
        if (!canPlace(p.modules, stack.id, p.from).replaces || !canStart(p.modules, base).ok) return null;
        return { ok: true, why: `New stack beside ${stackName(stack)}: ${modulesLabel(p.modules)} on a copy of ${module.layer === "template" ? module.name : ""}` };
      }
      if (p.type !== "sub") return null;
      const v = canPlaceSub(p.sub, stack.id, layer, p.from);
      if (!v.ok) return v.why ? v : null;
      const replaces = (module as { subs: AnySub[] }).subs.some((x) => x.key === p.sub.key);
      const how = p.from.kind === "deleted" ? "Restore" : "Copy";
      return { ok: true, why: `${how} ${subSummary(p.sub).title} here${replaces ? " (replaces this one's)" : ""}` };
    },
    onDrop(p) {
      if (p.type === "modules") newStack(p.modules, p.from, useBoard.getState().stacks.findIndex((s) => s.id === stack.id) + 1, false, base);
      if (p.type === "sub") placeSub(p.sub, p.from, { stackId: stack.id, layer: layer as "extensions" | "customization" });
    },
  });
  const open = (focus?: string) => openEditor({ stackId: stack.id, moduleId: module.id, layer, focus, from: rectOf(ref.current) });
  const selected = useBoard((s) => s.selected.includes(module.id));
  useImages();
  const building = isBuilding(stack);
  const state = buildStateOf(module);

  return (
    <div
      ref={ref}
      {...drop.props}
      data-module={module.id}
      className={`mod-tile${lifted ? " lifted" : ""}${selected ? " selected" : ""}${dropClass(drop)}`}
      onPointerDown={drag.onPointerDown}
      onClick={(e) => (selecting(e) ? useBoard.getState().toggleSelect(module.id) : open())}
      title="Click to edit · Ctrl+click to select · drag to copy onto another stack"
    >
      <ModuleFace
        stack={stack}
        module={module}
        compact={compact}
        state={state === "unbuilt" && building ? "building" : state}
        slots={{
          win: (sub) => <SubWin key={sub.id} sub={sub} stack={stack} onOpen={() => open(sub.key)} />,
          tray: (sub) => <SubTray key={sub.id} sub={sub} stack={stack} onOpen={() => open(sub.key)} />,
          name: <NameField stack={stack} module={module} />,
          blank: (k) => <BlankWin key={k} k={k} onOpen={() => open(k)} />,
          prompt: (p) => <PromptButton key={p.label} p={p} onOpen={() => open(p.focus)} />,
        }}
      />
    </div>
  );
}

/** A module's name: click it to rename it in place (Enter or clicking away saves, Esc cancels). */
function NameField({ stack, module }: { stack: Stack; module: Module }) {
  const [editing, setEditing] = useState(false);
  const name = moduleName(module);
  const [value, setValue] = useState(name);
  const stacks = useBoard((s) => s.stacks);
  // Names are unique per kind (but for what's shared): say so as it's typed.
  const clash = editing && value.trim() !== name ? nameClash(stacks, stack.id, module, value) : null;
  const done = (save: boolean) => {
    if (save && value.trim() && value.trim() !== name) {
      if (useBoard.getState().rename(stack.id, module.id, value)) return;
    }
    setEditing(false);
  };
  if (!editing)
    return (
      <span
        className="mod-name renamable"
        title="Click to rename"
        onClick={(e) => {
          if (selecting(e)) return;
          e.stopPropagation();
          setValue(module.layer === "customization" && name === "Untitled" ? "" : name);
          setEditing(true);
        }}
      >
        {name}
      </span>
    );
  return (
    <span className="name-edit">
      <input
        className={`mod-name-input${clash ? " clash" : ""}`}
        autoFocus
        value={value}
        placeholder="Name"
        title={clash ?? undefined}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setValue(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        // Clicking away with a name that's taken lets it go instead.
        onBlur={() => done(!clash)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") done(true);
          if (e.key === "Escape") done(false);
        }}
      />
      {clash && <span className="name-clash">{clash}</span>}
    </span>
  );
}

/** Makes a submodule draggable out of its module; a click opens the editor on it. */
function useSub(sub: AnySub, stack: Stack, ghost: React.ReactNode) {
  const layer = sub.key === "vscode" || sub.key === "wadbrowser" || sub.key === "tools" ? "extensions" : "customization";
  const drag = useDraggable(() => ({ payload: { type: "sub", sub, from: { kind: "module", stackId: stack.id, layer } }, ghost }));
  // Dragging copies, so the original stays put.
  const lifted = false;
  return { drag, lifted };
}

function SubWin({ sub, stack, onOpen }: { sub: AppSub; stack: Stack; onOpen(): void }) {
  const fit = sub.key === "tools" ? { ok: true } : subFits(sub.key, appsOf(stack));
  const face = <AppSubWindow sub={sub} warn={fit.ok ? undefined : fit.why} />;
  const { drag, lifted } = useSub(sub, stack, face);
  return (
    <div className={`sub-grab${lifted ? " lifted" : ""}`} onPointerDown={drag.onPointerDown} onClick={(e) => !selecting(e) && (e.stopPropagation(), onOpen())}>
      {face}
    </div>
  );
}

function SubTray({ sub, stack, onOpen }: { sub: CustomSub; stack: Stack; onOpen(): void }) {
  const { drag, lifted } = useSub(sub, stack, <ChipFace sub={sub} stack={stack} />);
  return (
    <span className={`sub-grab${lifted ? " lifted" : ""}`} onPointerDown={drag.onPointerDown} onClick={(e) => !selecting(e) && (e.stopPropagation(), onOpen())}>
      <TrayFace sub={sub} stack={stack} />
    </span>
  );
}

// ─────────────────────────────── dialogs ───────────────────────────────

/** What's wrong with a stack's configuration, and a fix for each: add the app it needs, or take out what needs it. */
function FixDialog({ stack, onClose }: { stack: Stack; onClose(): void }) {
  const live = useBoard((s) => s.stacks.find((x) => x.id === stack.id)) ?? stack;
  const problems = problemsOf(live);
  useEffect(() => {
    if (!problems.length) onClose();
  }, [problems.length, onClose]);
  return (
    <>
      <div className="scrim scrim-open" onClick={onClose} />
      <div className="dialog fix-dialog" role="dialog">
        <div className="dialog-title">
          <AlertTriangle size={16} /> {stackName(live)} isn't configured right
        </div>
        <p className="rail-note">Fix each problem: give the template the app, or remove what needs it.</p>
        <div className="fix-list">
          {problems.map((p) => (
            <div key={p.id} className="fix-item">
              <p>{p.text}</p>
              <div className="fix-actions">
                {p.fixes.map((f) => (
                  <button key={f.label} className={f.kind === "addApp" ? "btn-mini" : "btn-mini ghost danger-text"} onClick={() => useBoard.getState().fix(live.id, f)}>
                    <Wrench size={11} /> {f.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="dialog-actions">
          <button className="btn-ghost" onClick={onClose}>
            Later
          </button>
        </div>
      </div>
    </>
  );
}

/** "Are you sure?" before a whole stack is deleted. */
export function ConfirmDeleteDialog() {
  const confirming = useBoard((s) => s.confirming);
  const stacks = useBoard((s) => s.stacks);
  const { confirm, deleteIds } = useBoard.getState();
  if (!confirming) return null;
  const ids = confirming.ids;
  const whole = stacks.filter((st) => modulesOf(st).length && modulesOf(st).every((m) => ids.includes(m.id)));
  const others = ids.length - whole.reduce((n, st) => n + modulesOf(st).length, 0);
  const names = whole.map(stackName).join(", ");
  return (
    <>
      <div className="scrim scrim-open" onClick={() => confirm(null)} />
      <div className="dialog" role="alertdialog">
        <div className="dialog-title">Delete {whole.length === 1 && !others ? stackName(whole[0]) : `${ids.length} modules`}?</div>
        <p className="rail-note">
          {whole.length === 1 ? `The whole of ${names} goes` : `Whole stacks go: ${names}`}
          {others > 0 ? `, plus ${others} more module${others === 1 ? "" : "s"}` : ""}. They wait in Recently deleted, and Undo brings them back.
        </p>
        <div className="dialog-actions">
          <button className="btn-ghost" onClick={() => confirm(null)} autoFocus>
            Cancel
          </button>
          <button className="btn-danger" onClick={() => deleteIds(ids)}>
            <Trash2 size={13} /> Delete {whole.length === 1 && !others ? "stack" : "them"}
          </button>
        </div>
      </div>
    </>
  );
}

// ─────────────────────────────── delete (bottom left) ───────────────────────────────

/** Build and Delete, side by side along the bottom. */
export function Buckets() {
  return (
    <div className="bottom-buckets">
      <div className="bucket-row">
        <BuildBucket />
        <DeleteBucket />
      </div>
    </div>
  );
}

/** Drop a wadspace (or any module of one) to build the images it doesn't have yet. */
function BuildBucket() {
  const b = useBoard.getState();
  const picked = useBoard((s) => s.selected);
  const selected = picked.length;
  const stacks = useBoard((s) => s.stacks);
  useImages();
  const building = stacks.filter(isBuilding).map((st) => st.id);
  // What a click builds: stacks not built yet that can be (a template to build on, nothing to fix, a named customization).
  const waiting = stacks.filter((st) => unbuiltOf(st).length && !building.includes(st.id));
  const buildable = waiting.filter((st) => appsOf(st).length && !problemsOf(st).length && lookOf(st)?.name.trim());
  const skipped = waiting.length - buildable.length;
  const count = selected ? buildable.filter((st) => modulesOf(st).some((m) => picked.includes(m.id))).length : buildable.length;
  const drop = useDropTarget("bucket:build", {
    accepts(p) {
      if (p.type !== "modules") return p.type === "sub" ? { ok: false, why: "Drop the module (or its stack) to build it" } : null;
      if (p.from.kind !== "stack") return { ok: false, why: "Not on the board" };
      // Customizations have nothing to build: dropping one here does nothing.
      if (p.modules.every((m) => m.layer === "customization")) return { ok: false, why: "Customizations don't need building" };
      const stack = b.stacks.find((st) => st.id === (p.from as { stackId: string }).stackId);
      if (!stack) return null;
      if (building.includes(stack.id)) return { ok: false, why: `${stackName(stack)} is building` };
      const todo = unbuiltOf(stack).length;
      if (!todo) return { ok: false, why: `${stackName(stack)} is already built` };
      if (!appsOf(stack).length) return { ok: false, why: `${stackName(stack)} needs a template to build on` };
      if (problemsOf(stack).length) return { ok: false, why: `Fix ${stackName(stack)}'s configuration first` };
      if (!lookOf(stack)?.name.trim()) return { ok: false, why: `${stackName(stack)} needs a named Customization` };
      return { ok: true, why: `Build ${stackName(stack)}: ${todo} image${todo === 1 ? "" : "s"}` };
    },
    onDrop(p) {
      if (p.type === "modules" && p.from.kind === "stack") b.buildStack(p.from.stackId);
    },
  });
  const cls = drop.over ? (drop.over.ok ? " drop-ok" : " drop-no") : drop.could ? " drop-could" : "";
  return (
    <div
      {...drop.props}
      data-tour="build"
      className={`bucket bucket-build${selected ? " armed" : ""}${cls}`}
      onClick={() => (selected ? b.buildSelected() : b.buildAll())}
      title={selected ? "Build the stacks of what's selected" : "Click to build everything not built, or drop a wadspace here to build just it"}
    >
      <Hammer size={18} />
      <span className="bucket-name">
        {selected ? "Build selected" : "Build all"}
        {count > 0 && <span className="build-count">{count}</span>}
      </span>
      <small>
        {building.length
          ? `Building ${building.length}…`
          : count
            ? skipped && !selected
              ? `${skipped} more need${skipped === 1 ? "s" : ""} fixing or a template`
              : "Or drop a wadspace to build just it"
            : skipped
              ? `${skipped} need${skipped === 1 ? "s" : ""} fixing or a template first`
              : "Everything's built"}
      </small>
    </div>
  );
}

function DeleteBucket() {
  const b = useBoard.getState();
  const deleted = useBoard((s) => s.deleted);
  const selected = useBoard((s) => s.selected.length);
  const [open, setOpen] = useState(false);
  const del = useDropTarget("bucket:delete", {
    accepts(p) {
      if (p.type === "modules") {
        if (p.from.kind !== "stack") return { ok: false, why: "Not on the board" };
        const stack = b.stacks.find((st) => st.id === (p.from as { stackId: string }).stackId);
        const whole = !!stack && modulesOf(stack).every((m) => p.modules.some((x) => x.id === m.id));
        return { ok: true, why: whole ? `Delete ${stack ? stackName(stack) : "the stack"}, the whole stack…` : `Delete ${modulesLabel(p.modules)}` };
      }
      if (p.type === "sub") return p.from.kind === "module" ? { ok: true, why: `Delete ${subSummary(p.sub).title}` } : { ok: false, why: "Already deleted" };
      return null;
    },
    onDrop(p) {
      if (p.type === "modules") b.deleteModules(p.modules, p.from);
      if (p.type === "sub") b.deleteSub(p.sub, p.from);
    },
  });
  const cls = del.over ? (del.over.ok ? " drop-ok" : " drop-no") : del.could ? " drop-could" : "";

  return (
    <div className="delete-wrap">
      <div
        {...del.props}
        className={`bucket bucket-delete${selected ? " armed" : ""}${cls}`}
        onClick={() => (selected ? b.deleteSelected() : setOpen((o) => !o))}
        title={selected ? "Delete what's selected (Delete key)" : "Recently deleted"}
      >
        <Trash2 size={18} />
        <span className="bucket-name">{selected ? `Delete ${selected} selected` : "Delete"}</span>
        <small>
          {selected
            ? "Click, or press Delete · Esc to clear"
            : deleted.length
              ? `${deleted.length} recently deleted · click to see`
              : "Drop a module here, or Ctrl+click modules to select them"}
        </small>
        {deleted.length > 0 && !selected && <span className="deleted-count">{deleted.length}</span>}
      </div>
      {selected > 0 && (
        <button className="btn-ghost" onClick={b.clearSelection}>
          Clear selection
        </button>
      )}
      {open && <RecentlyDeleted onClose={() => setOpen(false)} />}
    </div>
  );
}

function RecentlyDeleted({ onClose }: { onClose(): void }) {
  const deleted = useBoard((s) => s.deleted);
  return (
    <div className="deleted-pop" onClick={(e) => e.stopPropagation()}>
      <div className="deleted-head">
        <span>Recently deleted</span>
        <button className="icon-btn" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      <p className="rail-note">Drag one back onto a stack, or between two stacks, to restore it.</p>
      {deleted.length === 0 && <p className="empty-note">Nothing here.</p>}
      <div className="deleted-list" data-autoscroll>
        {deleted.map((d) => (d.what === "module" ? <DeletedModule key={d.id} id={d.id} module={d.module} from={d.from} /> : <DeletedSub key={d.id} id={d.id} sub={d.sub} from={d.from} />))}
      </div>
    </div>
  );
}

function DeletedModule({ id, module, from }: { id: string; module: Module; from: string }) {
  const src: ModuleSource = { kind: "deleted", deletedId: id };
  const face = <Pile stack={stackOf([module])} modules={[module]} />;
  const drag = useDraggable(() => ({ payload: { type: "modules", modules: [module], from: src } as Payload, ghost: face }));
  return (
    <div className="deleted-item" onPointerDown={drag.onPointerDown}>
      {face}
      <small>from {from}</small>
    </div>
  );
}

function DeletedSub({ id, sub, from }: { id: string; sub: AnySub; from: string }) {
  const drag = useDraggable(() => ({ payload: { type: "sub", sub, from: { kind: "deleted", deletedId: id } }, ghost: <ChipFace sub={sub} /> }));
  return (
    <div className="deleted-item" onPointerDown={drag.onPointerDown}>
      <ChipFace sub={sub} />
      <small>from {from}</small>
    </div>
  );
}

// ─────────────────────────────── toasts ───────────────────────────────

export function Toasts() {
  const toasts = useBoard((s) => s.toasts);
  const { undo, dismiss } = useBoard.getState();
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className="toast">
          <span>{t.text}</span>
          {t.undo && (
            <button className="btn-ghost" onClick={undo}>
              <Undo2 size={13} /> Undo
            </button>
          )}
          <button className="icon-btn" onClick={() => dismiss(t.id)}>
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
