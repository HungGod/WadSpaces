// The Extensions editor: one window per app the template has that can be set
// up (WadBrowser's web apps, VS Code's extensions, the command line's tools),
// holding the actual items. The palette on the left offers single items to
// drag (or click) in: only for apps that are there, and only what isn't in
// yet.
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Plus, Trash2, X } from "lucide-react";
import { APP_SUB_INFO, EXTENSIONS, TOOLS, extension, subFits, tool, webappIcon, webappId } from "../catalog";
import { appsOf, subOf, uid, type AppSub, type AppSubKey, type BrowserSub, type ExtensionsModule, type Stack, type WebApp } from "../model";
import { useBoard } from "../store";
import { useDraggable, useDropTarget, type Item } from "../drag";
import { Img } from "../faces";

/** Web apps worth suggesting even when no other wadspace has them. */
const COMMON: WebApp[] = [
  { id: "github", name: "GitHub", url: "https://github.com" },
  { id: "gmail", name: "Gmail", url: "https://mail.google.com" },
  { id: "google-drive", name: "Google Drive", url: "https://drive.google.com" },
  { id: "claude", name: "Claude", url: "https://claude.ai" },
  { id: "youtube", name: "YouTube", url: "https://youtube.com" },
];

const itemKey = (i: Item): AppSubKey => (i.kind === "webapp" ? "wadbrowser" : i.kind === "extension" ? "vscode" : "tools");
const itemName = (i: Item) => (i.kind === "webapp" ? i.webapp.name : i.kind === "extension" ? extension(i.id).name : tool(i.id).name);
const itemIcon = (i: Item) => (i.kind === "webapp" ? webappIcon(i.webapp) : i.kind === "extension" ? (extension(i.id).icon ?? APP_SUB_INFO.vscode.icon) : APP_SUB_INFO.tools.icon);

export function ExtensionsEditor({ stack, draft, set, focus }: { stack: Stack; draft: ExtensionsModule; set(m: ExtensionsModule): void; focus?: string }) {
  const apps = appsOf(stack);
  const keys: AppSubKey[] = [...(apps.includes("wadbrowser") ? ["wadbrowser" as const] : []), ...(apps.includes("vscode") ? ["vscode" as const] : []), "tools"];
  // Setups moved in for an app this template doesn't have.
  const strays = draft.subs.filter((s) => !subFits(s.key, apps).ok);

  const blank = (key: AppSubKey): AppSub => {
    const base = { id: uid(key), origin: draft.name };
    return key === "vscode" ? { key, ...base, extensions: [] } : key === "wadbrowser" ? { key, ...base, mode: "browser", webapps: [] } : { key, ...base, tools: [] };
  };
  const sub = <K extends AppSubKey>(key: K) => (subOf(draft, key) ?? blank(key)) as Extract<AppSub, { key: K }>;
  const put = (s: AppSub) => {
    const empty = s.key === "vscode" ? !s.extensions.length : s.key === "tools" ? !s.tools.length : !s.webapps.length && s.mode === "browser";
    set({ ...draft, subs: [...draft.subs.filter((x) => x.key !== s.key), ...(empty ? [] : [s])] });
  };
  const has = (i: Item) =>
    i.kind === "webapp"
      ? !!subOf(draft, "wadbrowser")?.webapps.some((w) => w.id === i.webapp.id)
      : i.kind === "extension"
        ? !!subOf(draft, "vscode")?.extensions.includes(i.id)
        : !!subOf(draft, "tools")?.tools.includes(i.id);
  const add = (i: Item) => {
    if (has(i)) return;
    if (i.kind === "webapp") put({ ...sub("wadbrowser"), webapps: [...sub("wadbrowser").webapps, i.webapp] });
    else if (i.kind === "extension") put({ ...sub("vscode"), extensions: [...sub("vscode").extensions, i.id] });
    else put({ ...sub("tools"), tools: [...sub("tools").tools, i.id] });
  };

  return (
    <div className="ext-editor">
      <Palette keys={keys} has={has} add={add} />
      <section className="ext-main" data-autoscroll>
        <div className="field inline">
          <label>Name</label>
          <input value={draft.name} onChange={(e) => set({ ...draft, name: e.target.value })} />
        </div>
        <div className="ext-wins">
          {keys.includes("wadbrowser") && <BrowserWin sub={sub("wadbrowser")} put={put} add={add} focused={focus === "wadbrowser"} />}
          {keys.includes("vscode") && (
            <ItemWin k="vscode" focused={focus === "vscode"} add={add} items={sub("vscode").extensions.map((id) => ({ kind: "extension" as const, id }))} remove={(i) => i.kind === "extension" && put({ ...sub("vscode"), extensions: sub("vscode").extensions.filter((x) => x !== i.id) })} />
          )}
          <ItemWin k="tools" focused={focus === "tools"} add={add} items={sub("tools").tools.map((id) => ({ kind: "tool" as const, id }))} remove={(i) => i.kind === "tool" && put({ ...sub("tools"), tools: sub("tools").tools.filter((x) => x !== i.id) })} />
        </div>
        {strays.map((s) => (
          <div key={s.id} className="warn-note block">
            <AlertTriangle size={14} /> {APP_SUB_INFO[s.key].title}: {subFits(s.key, apps).why}, so it does nothing here.
            <button className="btn-ghost" onClick={() => set({ ...draft, subs: draft.subs.filter((x) => x.id !== s.id) })}>
              <Trash2 size={13} /> Remove
            </button>
          </div>
        ))}
      </section>
    </div>
  );
}

// ─────────────────────────────── the palette ───────────────────────────────

function Palette({ keys, has, add }: { keys: AppSubKey[]; has(i: Item): boolean; add(i: Item): void }) {
  const stacks = useBoard((s) => s.stacks);
  const [site, setSite] = useState("");
  const [ext, setExt] = useState("");

  const webapps = useMemo(() => {
    const m = new Map<string, WebApp>();
    for (const s of stacks) for (const w of subOf(s.extensions, "wadbrowser")?.webapps ?? []) m.set(w.id, w);
    for (const w of COMMON) if (!m.has(w.id)) m.set(w.id, w);
    return [...m.values()].map((webapp) => ({ kind: "webapp" as const, webapp }));
  }, [stacks]);
  const exts = useMemo(() => {
    const ids = new Set(EXTENSIONS.map((e) => e.id));
    for (const s of stacks) for (const id of subOf(s.extensions, "vscode")?.extensions ?? []) ids.add(id);
    return [...ids].map((id) => ({ kind: "extension" as const, id }));
  }, [stacks]);
  const tools = TOOLS.map((t) => ({ kind: "tool" as const, id: t.id }));

  const section = (key: AppSubKey, items: Item[], form?: React.ReactNode) => {
    const left = items.filter((i) => !has(i));
    return (
      <div key={key} className="pal-section">
        <div className="group-label">
          <Img src={APP_SUB_INFO[key].icon} className="tiny" /> {key === "wadbrowser" ? "Web apps" : key === "vscode" ? "VS Code extensions" : "Tools"}
        </div>
        <div className="pal-items">
          {left.map((i) => (
            <PalItem key={i.kind === "webapp" ? i.webapp.id : i.id} item={i} onAdd={() => add(i)} />
          ))}
          {left.length === 0 && <span className="empty-note">All added</span>}
        </div>
        {form}
      </div>
    );
  };

  return (
    <aside className="panel palette-ext" data-autoscroll>
      <div className="panel-title">Add</div>
      <p className="rail-note">Drag onto its app, or click.</p>
      {keys.includes("wadbrowser") &&
        section(
          "wadbrowser",
          webapps,
          <form
            className="add-row"
            onSubmit={(e) => {
              e.preventDefault();
              const url = /^https?:\/\//.test(site) ? site : `https://${site}`;
              try {
                const host = new URL(url).hostname.replace(/^www\./, "");
                const name = host.split(".")[0].replace(/^./, (c) => c.toUpperCase());
                add({ kind: "webapp", webapp: { id: webappId(name), name, url } });
                setSite("");
              } catch {
                /* not a site */
              }
            }}
          >
            <input placeholder="Another site, e.g. notion.so" value={site} onChange={(e) => setSite(e.target.value)} />
          </form>,
        )}
      {keys.includes("vscode") &&
        section(
          "vscode",
          exts,
          <form
            className="add-row"
            onSubmit={(e) => {
              e.preventDefault();
              if (/^[\w-]+\.[\w.-]+$/.test(ext)) add({ kind: "extension", id: ext });
              setExt("");
            }}
          >
            <input placeholder="Marketplace id, e.g. ms-toolsai.jupyter" value={ext} onChange={(e) => setExt(e.target.value)} />
          </form>,
        )}
      {section("tools", tools)}
    </aside>
  );
}

function ItemFace({ item }: { item: Item }) {
  return (
    <span className={`item item-${item.kind}`}>
      <Img src={itemIcon(item)} />
      <span>{itemName(item)}</span>
    </span>
  );
}

function PalItem({ item, onAdd }: { item: Item; onAdd(): void }) {
  const drag = useDraggable(() => ({ payload: { type: "item", item }, ghost: <ItemFace item={item} /> }));
  return (
    <span className="pal-item" onPointerDown={drag.onPointerDown} onClick={onAdd} title={item.kind === "webapp" ? item.webapp.url : item.kind === "extension" ? item.id : undefined}>
      <ItemFace item={item} />
      <Plus size={11} className="pal-plus" />
    </span>
  );
}

// ─────────────────────────────── the app windows ───────────────────────────────

function useItemDrop(k: AppSubKey, add: (i: Item) => void) {
  return useDropTarget(`ext:${k}`, {
    accepts: (p) => (p.type !== "item" ? null : itemKey(p.item) === k ? { ok: true, why: `Add ${itemName(p.item)} to ${APP_SUB_INFO[k].app}` } : { ok: false, why: `That goes in ${APP_SUB_INFO[itemKey(p.item)].app}` }),
    onDrop: (p) => p.type === "item" && add(p.item),
  });
}

function useFocusRef(focused: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focused) setTimeout(() => ref.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 360);
  }, [focused]);
  return ref;
}

function WinShell({ k, count, focused, drop, extra, children }: { k: AppSubKey; count: number; focused: boolean; drop: ReturnType<typeof useDropTarget>; extra?: React.ReactNode; children: React.ReactNode }) {
  const ref = useFocusRef(focused);
  const cls = drop.over ? (drop.over.ok ? " drop-ok" : " drop-no") : drop.could ? " drop-could" : "";
  return (
    <div ref={ref} {...drop.props} className={`big-win${focused ? " focused" : ""}${cls}`}>
      <div className="big-win-bar">
        <Img src={APP_SUB_INFO[k].icon} />
        <span>{APP_SUB_INFO[k].app}</span>
        <span className="win-count">{count}</span>
        <div className="spacer" />
        {extra}
      </div>
      <div className="big-win-body">{children}</div>
    </div>
  );
}

function ItemWin({ k, items, add, remove, focused }: { k: "vscode" | "tools"; items: Item[]; add(i: Item): void; remove(i: Item): void; focused: boolean }) {
  const drop = useItemDrop(k, add);
  return (
    <WinShell k={k} count={items.length} focused={focused} drop={drop}>
      <div className="win-items">
        {items.map((i) => (
          <span key={i.kind === "webapp" ? i.webapp.id : i.id} className="win-item">
            <ItemFace item={i} />
            <button className="item-x" title="Remove" onClick={() => remove(i)}>
              <X size={10} />
            </button>
          </span>
        ))}
        {items.length === 0 && <span className="empty-note">Drag {k === "vscode" ? "extensions" : "tools"} here</span>}
      </div>
    </WinShell>
  );
}

function BrowserWin({ sub, put, add, focused }: { sub: BrowserSub; put(s: BrowserSub): void; add(i: Item): void; focused: boolean }) {
  const drop = useItemDrop("wadbrowser", add);
  return (
    <WinShell
      k="wadbrowser"
      count={sub.webapps.length}
      focused={focused}
      drop={drop}
      extra={
        <div className="seg small-seg">
          {(["browser", "focus"] as const).map((m) => (
            <button key={m} className={sub.mode === m ? "on" : ""} onClick={() => put({ ...sub, mode: m })} title={m === "browser" ? "With an address bar" : "Web apps only"}>
              {m === "browser" ? "Browser" : "Focus"}
            </button>
          ))}
        </div>
      }
    >
      <div className="win-items">
        {sub.webapps.map((w) => (
          <span key={w.id} className="win-item" title={w.url}>
            <ItemFace item={{ kind: "webapp", webapp: w }} />
            <button className="item-x" title="Remove" onClick={() => put({ ...sub, webapps: sub.webapps.filter((x) => x.id !== w.id) })}>
              <X size={10} />
            </button>
          </span>
        ))}
        {sub.webapps.length === 0 && <span className="empty-note">Drag web apps here</span>}
      </div>
    </WinShell>
  );
}

