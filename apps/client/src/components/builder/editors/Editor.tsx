// The open editor: grows out of the module (or the Edit bucket) to fill the
// board, and shrinks back into the module on Save or Cancel.
import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { LAYER_INFO, moduleName, modulesOf, stackName, type CustomizationModule, type ExtensionsModule, type Module, type Stack, type TemplateModule } from "../model";
import { NEW, nameClash, useBoard, type Editing } from "../store";
import { LAYER_ICON } from "../faces";
import { CustomizationEditor } from "./CustomizationEditor";
import { ExtensionsEditor } from "./ExtensionsEditor";
import { TemplateEditor } from "./TemplateEditor";

type Box = { x: number; y: number; w: number; h: number };
const full = (): Box => ({ x: 16, y: 16, w: innerWidth - 32, h: innerHeight - 32 });

export function EditorLayer() {
  const editing = useBoard((s) => s.editing);
  return editing ? <EditorShell key={editing.moduleId} editing={editing} /> : null;
}

function EditorShell({ editing }: { editing: Editing }) {
  // A module for the board's first wadspace edits inside an empty stack.
  const found = useBoard((s) => s.stacks.find((x) => x.id === editing.stackId));
  const stack: Stack | undefined = editing.stackId === NEW ? { id: NEW, templates: [] } : found;
  const { saveModule, closeEditor } = useBoard.getState();
  const [draft, setDraft] = useState<Module | undefined>(() => {
    const m = editing.fresh ?? (stack && modulesOf(stack).find((x) => x.id === editing.moduleId));
    return m && structuredClone(m);
  });
  const [box, setBox] = useState<Box>(editing.from);
  const [phase, setPhase] = useState<"grow" | "open" | "shrink">("grow");

  useLayoutEffect(() => {
    const r = requestAnimationFrame(() => requestAnimationFrame(() => setBox(full())));
    const t = setTimeout(() => setPhase("open"), 340);
    return () => (cancelAnimationFrame(r), clearTimeout(t));
  }, []);
  useEffect(() => {
    const resize = () => phase === "open" && setBox(full());
    addEventListener("resize", resize);
    return () => removeEventListener("resize", resize);
  }, [phase]);

  const stacks = useBoard((s) => s.stacks);
  // Names are unique per kind (but for what's shared): Save waits for a free one.
  const clash = draft ? nameClash(stacks, editing.stackId, draft, moduleName(draft) === "Untitled" ? "" : moduleName(draft)) : null;
  // A shared template whose apps changed is a different template now: offer a free name for it.
  const original = stack && modulesOf(stack).find((x) => x.id === editing.moduleId);
  const forked = !!clash && draft?.layer === "template" && original?.layer === "template" && original.name === draft.name;
  const freeName = (() => {
    if (!forked || !draft || draft.layer !== "template") return "";
    const taken = stacks.flatMap((st) => st.templates.map((t) => t.name.toLowerCase()));
    const base = draft.name.replace(/ - \d+$/, "");
    let n = 1;
    while (taken.includes(`${base} - ${n}`.toLowerCase())) n++;
    return `${base} - ${n}`;
  })();
  const close = (save: boolean) => {
    if (save && clash) return;
    if (save && draft) saveModule(editing, draft);
    // Shrink back into wherever the module is now.
    const el = document.querySelector(`[data-module="${editing.moduleId}"]`);
    const r = el?.getBoundingClientRect();
    setPhase("shrink");
    setBox(r ? { x: r.left, y: r.top, w: r.width, h: r.height } : editing.from);
    setTimeout(closeEditor, 330);
  };

  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && !document.body.classList.contains("is-dragging") && close(false);
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  });

  if (!stack || !draft) return null;
  const Icon = LAYER_ICON[editing.layer];
  // The stack as it would be with the draft saved.
  const live: Stack =
    draft.layer === "template"
      ? { ...stack, templates: editing.fresh ? [...stack.templates, draft] : stack.templates.map((t) => (t.id === draft.id ? draft : t)) }
      : { ...stack, [draft.layer]: draft };

  let body: ReactNode;
  if (draft.layer === "template") body = <TemplateEditor stack={live} draft={draft} set={(m: TemplateModule) => setDraft(m)} />;
  else if (draft.layer === "extensions") body = <ExtensionsEditor stack={live} draft={draft} set={(m: ExtensionsModule) => setDraft(m)} focus={editing.focus} />;
  else body = <CustomizationEditor stack={live} draft={draft} set={(m: CustomizationModule) => setDraft(m)} focus={editing.focus} />;

  return (
    <>
      <div className={`scrim scrim-${phase}`} onClick={() => close(false)} />
      <div className={`editor editor-${editing.layer} editor-${phase}`} style={{ left: box.x, top: box.y, width: box.w, height: box.h }}>
        <header className="editor-head">
          <span className="editor-icon">
            <Icon size={20} />
          </span>
          <div className="editor-titles">
            <span className="editor-kind">
              {LAYER_INFO[editing.layer].label} · {editing.stackId === NEW ? "Your first wadspace" : stackName(stack)}
            </span>
            <span className="editor-title">{moduleName(draft)}</span>
          </div>
          <div className="spacer" />
          <button className="btn-ghost" onClick={() => close(false)}>
            Cancel
          </button>
          {clash && !forked && <span className="name-clash in-head">{clash}</span>}
          {forked && draft && (
            <span className="fork-note">
              Its apps changed, so it's no longer the {draft.name} the other wadspaces share.
              <button className="btn-mini" onClick={() => setDraft({ ...draft, name: freeName } as Module)}>
                Name it {freeName}
              </button>
            </span>
          )}
          <button className="btn-primary" disabled={!!clash} title={clash ?? undefined} onClick={() => close(true)}>
            {editing.fresh ? "Add" : "Save and shrink"}
          </button>
          <button className="icon-btn" onClick={() => close(false)} title="Close">
            <X size={16} />
          </button>
        </header>
        <div className="editor-body">{body}</div>
      </div>
    </>
  );
}
