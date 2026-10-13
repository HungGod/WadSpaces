// The template editor: the UI mockup editor. Drag apps from the catalog onto
// the desktop, move them around (the image draws them in this order), drag
// them back to the catalog to take them out. A template built on another
// can't take out the apps it inherits; what's added here reaches the
// templates above.
import { useState } from "react";
import { AlertTriangle, Layers, Lock, X } from "lucide-react";
import { APPS, app, type CatalogApp } from "../catalog";
import { appsOf, subOf, type Stack, type TemplateModule } from "../model";
import { useDrag, useDraggable, useDropTarget } from "../drag";
import { Img, belowOf } from "../faces";

const ROWS = 5;

export function TemplateEditor({ stack, draft, set }: { stack: Stack; draft: TemplateModule; set(c: TemplateModule): void }) {
  const [picked, setPicked] = useState<string | null>(draft.apps[0] ?? null);
  const apps = draft.apps;

  const moveTo = (appId: string, from: number | undefined, to: number) => {
    const next = apps.filter((_, i) => i !== from);
    const at = Math.min(from !== undefined && from < to ? to - 1 : to, next.length);
    next.splice(at, 0, appId);
    set({ ...draft, apps: next });
    setPicked(appId);
  };
  const below = belowOf(stack, draft);
  // The desktop takes a drop anywhere: the app goes to the end, down the left side.
  const { active } = useDrag();
  const draggingApp = active?.payload.type === "app";
  const desk = useDropTarget("tpl:desktop", {
    accepts: (p) => (p.type !== "app" ? null : p.at === undefined ? { ok: true, why: `Add ${app(p.appId)?.name}` } : p.at === apps.length - 1 ? null : { ok: true, why: "Move to the end" }),
    onDrop: (p) => p.type === "app" && moveTo(p.appId, p.at, apps.length),
  });
  const above = stack.templates.slice(stack.templates.findIndex((t) => t.id === draft.id) + 1);
  const inherited = (id: string) => !!below?.apps.includes(id);
  const remove = (appId: string) => !inherited(appId) && set({ ...draft, apps: apps.filter((a) => a !== appId) });

  const palette = useDropTarget("tpl:palette", {
    accepts: (p) =>
      p.type !== "app" || p.at === undefined
        ? null
        : inherited(p.appId)
          ? { ok: false, why: `${app(p.appId)?.name} comes from ${below!.name}, the template this builds on` }
          : { ok: true, why: `Take ${app(p.appId)?.name} off the desktop` },
    onDrop: (p) => p.type === "app" && remove(p.appId),
  });

  const categories = [...new Set(APPS.map((a) => a.category))];
  const lost = [
    !appsOf(stack).includes("vscode") && subOf(stack.extensions, "vscode") && "VS Code extensions",
    !appsOf(stack).includes("wadbrowser") && subOf(stack.extensions, "wadbrowser") && "WadBrowser apps",
  ].filter(Boolean);

  return (
    <div className="tpl-editor">
      <aside {...palette.props} className={`panel palette${palette.over?.ok ? " drop-ok" : palette.could ? " drop-could" : ""}`} data-autoscroll>
        <div className="field">
          <label>Template name</label>
          <input value={draft.name} onChange={(e) => set({ ...draft, name: e.target.value })} />
        </div>
        <div className="field">
          <label>Description</label>
          <textarea rows={2} value={draft.description} onChange={(e) => set({ ...draft, description: e.target.value })} />
        </div>
        <div className="panel-title">Apps</div>
        <p className="rail-note">Drag an app onto the desktop. Drag one back here to take it out.</p>
        {categories.map((c) => (
          <div key={c} className="palette-group">
            <div className="group-label">{c}</div>
            <div className="palette-grid">
              {APPS.filter((a) => a.category === c).map((a) => (
                <PaletteApp key={a.id} a={a} on={apps.includes(a.id)} onPick={() => setPicked(a.id)} />
              ))}
            </div>
          </div>
        ))}
      </aside>

      <section className="tpl-stage">
        {/* Drop an app anywhere on the desktop: it takes the next spot down the left side. On an icon, it goes just before it. */}
        <div {...desk.props} className={`desktop desktop-template${desk.over?.ok ? " drop-ok" : ""}`}>
          <div className="desk-grid" style={{ gridTemplateRows: `repeat(${ROWS}, 96px)` }}>
            {apps.map((id, i) => (
              <DeskApp key={id} appId={id} at={i} picked={picked === id} onPick={() => setPicked(id)} locked={inherited(id)} onMove={moveTo} onRemove={() => remove(id)} />
            ))}
            {draggingApp && (
              <div className={`desk-cell next-spot${desk.over?.ok ? " lit" : ""}`}>
                <span>Next spot</span>
              </div>
            )}
          </div>
          <div className="desk-taskbar">
            <Img src="/brand/wadspaces-icon-dark-transparent.svg" className="tb-logo" />
            <div className="tb-apps">
              {apps.map((id) => (
                <Img key={id} src={app(id)?.icon ?? ""} />
              ))}
            </div>
            <span className="tb-clock">9:41</span>
          </div>
        </div>
        <div className="stage-notes">
          {below && (
            <span className="chain-note">
              <Lock size={12} /> Builds on {below.name}: its {below.apps.length} app{below.apps.length === 1 ? "" : "s"} are locked here; add more on top.
            </span>
          )}
          {above.length > 0 && (
            <span className="chain-note">
              <Layers size={12} /> {above.map((t) => t.name).join(", ")} build{above.length === 1 ? "s" : ""} on this: any app added here reaches {above.length === 1 ? "it" : "them"} too.
            </span>
          )}
          <span>Just this template's apps, in the order the desktop shows them. Preview a stack to see it finished.</span>
          {lost.length > 0 && (
            <span className="warn-note">
              <AlertTriangle size={13} /> Without those apps, this stack's {lost.join(" and ")} won't apply.
            </span>
          )}
        </div>
      </section>

      <aside className="panel app-detail">
        {picked && app(picked) ? (
          <>
            <Img src={app(picked)!.icon} className="detail-icon" />
            <div className="panel-title">{app(picked)!.name}</div>
            <p className="rail-note">{app(picked)!.summary}</p>
            <dl className="facts">
              <dt>Category</dt>
              <dd>{app(picked)!.category}</dd>
              <dt>Customization layer</dt>
              <dd>{app(picked)!.layer ? (app(picked)!.layer === "vscode" ? "Extensions" : "Web apps and mode") : "None"}</dd>
              <dt>Keeps a sign-in</dt>
              <dd>{app(picked)!.secret ? "Yes (a secret slot)" : "No"}</dd>
            </dl>
            {inherited(picked) ? (
              <p className="chain-note">
                <Lock size={12} /> From {below!.name}, the template this builds on
              </p>
            ) : apps.includes(picked) ? (
              <button className="btn-ghost" onClick={() => remove(picked)}>
                Take off the desktop
              </button>
            ) : (
              <button className="btn-primary" onClick={() => moveTo(picked, undefined, apps.length)}>
                Add to the desktop
              </button>
            )}
          </>
        ) : (
          <p className="rail-note">Pick an app to see what it brings.</p>
        )}
      </aside>
    </div>
  );
}

function PaletteApp({ a, on, onPick }: { a: CatalogApp; on: boolean; onPick(): void }) {
  const drag = useDraggable(() => ({
    payload: { type: "app", appId: a.id },
    ghost: (
      <div className="desk-icon ghosted">
        <Img src={a.icon} />
        <span>{a.name}</span>
      </div>
    ),
  }));
  return (
    <div className={`palette-app${on ? " on" : ""}`} onPointerDown={on ? undefined : drag.onPointerDown} onClick={onPick} title={on ? "On the desktop" : a.summary}>
      <Img src={a.icon} />
      <span>{a.name}</span>
    </div>
  );
}

function DeskApp({ appId, at, picked, locked, onPick, onMove, onRemove }: { appId: string; at: number; picked: boolean; locked: boolean; onPick(): void; onMove(appId: string, from: number | undefined, to: number): void; onRemove(): void }) {
  const a = app(appId);
  const drag = useDraggable(() => ({
    payload: { type: "app", appId, at },
    ghost: (
      <div className="desk-icon ghosted">
        <Img src={a?.icon ?? ""} />
        <span>{a?.name}</span>
      </div>
    ),
  }));
  const drop = useDropTarget(`tpl:app:${appId}`, {
    accepts: (p) => (p.type === "app" && p.appId !== appId ? { ok: true, why: p.at === undefined ? `Add ${app(p.appId)?.name} before ${a?.name}` : `Move before ${a?.name}` } : null),
    onDrop: (p) => p.type === "app" && onMove(p.appId, p.at, at),
  });
  return (
    <div {...drop.props} className={`desk-cell${drop.over?.ok ? " drop-before" : ""}`}>
      <div className={`desk-icon${picked ? " picked" : ""}`} onPointerDown={drag.onPointerDown} onClick={onPick}>
        <Img src={a?.icon ?? ""} />
        <span>{a?.name ?? appId}</span>
        {locked ? (
          <span className="desk-lock" title="From the template this builds on">
            <Lock size={9} />
          </span>
        ) : (
          <button className="desk-x" title="Take off" onClick={(e) => (e.stopPropagation(), onRemove())}>
            <X size={10} />
          </button>
        )}
      </div>
    </div>
  );
}
