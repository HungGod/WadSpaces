// How modules and submodules look: each module is a small desktop showing
// what its layer brings. No hooks here, so the drag ghost can draw them too;
// the board wraps them in draggable, droppable versions.
//
//   Template       its apps, as desktop icons and in the taskbar; one built
//                  on another shows the apps it inherits faded
//   Extensions     a little window per app setup: WadBrowser's web apps,
//                  VS Code's extensions, the command line's tools
//   Customization  the finished desktop: its background, every icon, its
//                  projects; Look, Projects and Secrets sit in the taskbar
import { useState, type ReactNode } from "react";
import type { AppSubKey } from "./model";
import { Folder, KeyRound, LayoutGrid, Palette, Puzzle } from "lucide-react";
import { APP_SUB_INFO, app, desktopOf, extension, keyCount, setupsFor, tool, wallpaperCss, webappIcon } from "./catalog";
import { LAYER_INFO, appsOf, isBlankWallpaper, lookOf, moduleName, type AnySub, type AppSub, type CustomSub, type Layer, type Module, type Stack, type TemplateModule } from "./model";

export const LAYER_ICON: Record<Layer, (p: { size?: number }) => ReactNode> = {
  template: ({ size = 14 }) => <LayoutGrid size={size} />,
  extensions: ({ size = 14 }) => <Puzzle size={size} />,
  customization: ({ size = 14 }) => <Palette size={size} />,
};

export function Img({ src, className, alt = "" }: { src: string; className?: string; alt?: string }) {
  const [bad, setBad] = useState(false);
  return <img src={bad ? "/favicon.svg" : src} alt={alt} className={className} draggable={false} onError={() => setBad(true)} />;
}

/** A small picture of a wadspace's desktop: its background and icons (the editors use it). */
export function MiniDesktop({ stack, rows = 3, className = "" }: { stack: Stack; rows?: number; className?: string }) {
  const icons = desktopOf(stack);
  return (
    <div className={`mini-desktop ${className}`} style={{ background: wallpaperCss(lookOf(stack)?.wallpaper) }}>
      <div className="mini-icons" style={{ gridTemplateRows: `repeat(${rows}, auto)` }}>
        {icons.slice(0, rows * 6).map((i) => (
          <div key={i.id} className="mini-icon" title={i.label}>
            <Img src={i.icon} />
          </div>
        ))}
      </div>
      <div className="mini-taskbar" />
    </div>
  );
}

// ─────────────────────────────── submodules ───────────────────────────────

/** What a submodule is, in a few words. */
export function subSummary(sub: AnySub, stack?: Stack): { icon: ReactNode; title: string; detail: string } {
  switch (sub.key) {
    case "vscode":
      return { icon: <Img src={APP_SUB_INFO.vscode.icon} />, title: "VS Code extensions", detail: `${sub.extensions.length}` };
    case "wadbrowser":
      return { icon: <Img src={APP_SUB_INFO.wadbrowser.icon} />, title: "Web apps", detail: `${sub.webapps.length}${sub.mode === "focus" ? " · focus" : ""}` };
    case "tools":
      return { icon: <Img src={APP_SUB_INFO.tools.icon} />, title: "Tools", detail: `${sub.tools.length}` };
    case "look":
      return { icon: <span className="swatch" style={{ background: wallpaperCss(sub.wallpaper) }} />, title: "Look", detail: sub.name || "Untitled" };
    case "folders":
      return { icon: <Folder size={12} />, title: "Projects", detail: `${sub.mounts.length}` };
    case "secrets": {
      const n = stack ? keyCount(stack) : null;
      const saved = Object.keys(sub.bySlot).length + (sub.groups ?? []).filter((g) => g.key).length;
      return { icon: <KeyRound size={12} />, title: "Secrets", detail: n ? `${n.set}/${n.all}` : `${saved}` };
    }
  }
}

/** A submodule as a compact pill (drag ghosts, Recently deleted, libraries). */
export function ChipFace({ sub, stack, warn }: { sub: AnySub; stack?: Stack; warn?: string }) {
  const s = subSummary(sub, stack);
  return (
    <span className={`chip chip-${sub.key}${warn ? " warn" : ""}`} title={warn}>
      <span className="chip-icon">{s.icon}</span>
      <span className="chip-title">{s.title}</span>
      <span className="chip-detail">{s.detail}</span>
    </span>
  );
}

/** An Extensions submodule as a little app window, showing what it sets up. */
export function AppSubWindow({ sub, warn }: { sub: AppSub; warn?: string }) {
  const info = APP_SUB_INFO[sub.key];
  return (
    <div className={`win win-${sub.key}${warn ? " warn" : ""}`} title={warn}>
      <div className="win-bar">
        <Img src={info.icon} />
        <span>{info.app}</span>
        <span className="win-count">
          {sub.key === "vscode" ? sub.extensions.length : sub.key === "wadbrowser" ? sub.webapps.length : sub.tools.length}
          {sub.key === "wadbrowser" && sub.mode === "focus" ? " · focus" : ""}
        </span>
      </div>
      <div className="win-body">
        {sub.key === "wadbrowser" &&
          (sub.webapps.length ? (
            <div className="win-grid">
              {sub.webapps.slice(0, 10).map((w) => (
                <Img key={w.id} src={webappIcon(w)} className="fav" />
              ))}
            </div>
          ) : (
            <span className="win-empty">No web apps</span>
          ))}
        {sub.key === "vscode" &&
          (sub.extensions.length ? (
            <div className="win-list">
              {sub.extensions.slice(0, 4).map((id) => {
                const e = extension(id);
                return (
                  <span key={id} className="ext">
                    {e.icon ? <Img src={e.icon} /> : <span className="ext-dot">{e.name[0]}</span>}
                    {e.name}
                  </span>
                );
              })}
              {sub.extensions.length > 4 && <span className="ext more">+{sub.extensions.length - 4}</span>}
            </div>
          ) : (
            <span className="win-empty">No extensions</span>
          ))}
        {sub.key === "tools" && (
          <code className="term">
            <span className="prompt">$</span> {sub.tools.map((t) => tool(t).name.replace(/ CLI| dev tools/, "").toLowerCase()).join(" ") || "—"}
          </code>
        )}
      </div>
    </div>
  );
}

/** An app setup a stack could have but doesn't: a blank, dashed window. */
export function BlankWindow({ k }: { k: AppSubKey }) {
  const info = APP_SUB_INFO[k];
  return (
    <div className={`win win-${k} blank`}>
      <div className="win-bar">
        <Img src={info.icon} />
        <span>{info.app}</span>
      </div>
      <div className="win-body">
        <span className="win-empty">+ Set up</span>
      </div>
    </div>
  );
}

/** An Extensions screen: a window per app setup it has, and a blank one for each it could have. */
function ExtensionsScreen({ stack, subs, win, blank }: { stack: Stack; subs: AppSub[]; win: (sub: AppSub) => ReactNode; blank?: (key: AppSubKey) => ReactNode }) {
  const possible = setupsFor(appsOf(stack));
  // Setups it has (even a stray one), then blanks, in WadBrowser / VS Code / Command line order.
  const keys = (["wadbrowser", "vscode", "tools"] as AppSubKey[]).filter((k) => possible.includes(k) || subs.some((s) => s.key === k));
  return (
    <div className="screen screen-extensions">
      <div className="wins">
        {keys.map((k) => {
          const sub = subs.find((s) => s.key === k);
          return sub ? win(sub) : blank ? blank(k) : <BlankWindow key={k} k={k} />;
        })}
      </div>
    </div>
  );
}

/** A stack without Extensions: a blank block with the setups it could have, to start one from. */
export function BlankExtensions({ stack, blank }: { stack: Stack; blank?: (key: AppSubKey) => ReactNode }) {
  const Icon = LAYER_ICON.extensions;
  return (
    <div className="mod mod-extensions blank-mod">
      <div className="mod-bar">
        <span className="mod-layer">
          <Icon size={13} />
          {LAYER_INFO.extensions.label}
        </span>
        <span className="mod-name faint">None yet</span>
      </div>
      <ExtensionsScreen stack={stack} subs={[]} win={() => null} blank={blank} />
    </div>
  );
}

/** Something a customization hasn't set yet, and what to say about it. */
export interface Prompt {
  /** The editor section it opens on. */
  focus: "look" | "folders" | "secrets";
  label: string;
}

/** What a customization (or a stack without one) still has to set: its name, background, folders, and the secrets its apps could keep. */
function promptsFor(stack: Stack, subs: CustomSub[]): { bar: Prompt[]; background: boolean } {
  const look = subs.find((s): s is Extract<CustomSub, { key: "look" }> => s.key === "look");
  const folders = subs.find((s) => s.key === "folders");
  const secrets = subs.find((s) => s.key === "secrets");
  const { all: slots, set } = keyCount(stack);
  const bar: Prompt[] = [];
  if (!look?.name.trim()) bar.push({ focus: "look", label: "+ Name" });
  if (!folders || (folders.key === "folders" && !folders.mounts.length)) bar.push({ focus: "folders", label: "+ Projects" });
  if (slots && (!secrets || !set)) bar.push({ focus: "secrets", label: `+ Secrets 0/${slots}` });
  return { bar, background: isBlankWallpaper(look?.wallpaper) };
}

export function PromptFace({ p }: { p: Prompt }) {
  return <span className="tray prompt">{p.label}</span>;
}

/** A Customization screen: the finished desktop, its submodules in the taskbar, and prompts for what isn't set. */
function CustomizationScreen({ stack, subs, tray, prompt }: { stack: Stack; subs: CustomSub[]; tray: (sub: CustomSub) => ReactNode; prompt?: (p: Prompt) => ReactNode }) {
  const look = subs.find((s): s is Extract<CustomSub, { key: "look" }> => s.key === "look");
  const { bar, background } = promptsFor(stack, subs);
  const draw = prompt ?? ((p: Prompt) => <PromptFace key={p.label} p={p} />);
  // Submodules with nothing in them yet show as prompts instead.
  const shown = sortedSubs(subs).filter((s) => !bar.some((p) => p.focus === s.key) && !(s.key === "look" && !s.name.trim()));
  return (
    <div className="screen screen-customization" style={{ background: wallpaperCss(look?.wallpaper) }}>
      <div className="desk small">
        {desktopOf(stack)
          .slice(0, 12)
          .map((i) => (
            <span key={i.id} className={`desk-app from-${i.from}`} title={i.label}>
              <Img src={i.icon} />
            </span>
          ))}
      </div>
      {background && <div className="bg-prompt">{draw({ focus: "look", label: "Set a background" })}</div>}
      <div className="taskbar tray-bar">
        {shown.map(tray)}
        {bar.map(draw)}
      </div>
    </div>
  );
}

/** A stack without a Customization: a blank block showing what it could set. */
export function BlankCustomization({ stack, prompt }: { stack: Stack; prompt?: (p: Prompt) => ReactNode }) {
  const Icon = LAYER_ICON.customization;
  return (
    <div className="mod mod-customization blank-mod">
      <div className="mod-bar">
        <span className="mod-layer">
          <Icon size={13} />
          {LAYER_INFO.customization.label}
        </span>
        <span className="mod-name faint">None yet</span>
      </div>
      <CustomizationScreen stack={stack} subs={[]} tray={() => null} prompt={prompt} />
    </div>
  );
}

/** A Customization submodule as a taskbar item. */
export function TrayFace({ sub, stack }: { sub: CustomSub; stack?: Stack }) {
  const s = subSummary(sub, stack);
  return (
    <span className={`tray tray-${sub.key}`}>
      <span className="tray-icon">{s.icon}</span>
      <span className="tray-title">{sub.key === "look" ? "Look" : s.title}</span>
      {sub.key !== "look" && <span className="tray-detail">{s.detail}</span>}
    </span>
  );
}

const SUB_ORDER: Record<AnySub["key"], number> = { wadbrowser: 0, vscode: 1, tools: 2, look: 0, folders: 1, secrets: 2 };
export const sortedSubs = <S extends AnySub>(subs: S[]) => [...subs].sort((a, b) => SUB_ORDER[a.key] - SUB_ORDER[b.key]);

// ─────────────────────────────── modules ───────────────────────────────

export interface FaceSlots {
  /** Draws an Extensions submodule (the board makes it draggable). */
  win?: (sub: AppSub) => ReactNode;
  /** Draws a Customization submodule. */
  tray?: (sub: CustomSub) => ReactNode;
  /** Draws the module's name (the board makes it renamable). */
  name?: ReactNode;
  /** Draws a blank window for an app setup it could have (the board makes it open the editor). */
  blank?: (key: AppSubKey) => ReactNode;
  /** Draws a prompt for something a customization hasn't set yet (the board makes it open the editor). */
  prompt?: (p: Prompt) => ReactNode;
  actions?: ReactNode;
}

/** The template under `t` in its stack, if it builds on one. */
export const belowOf = (stack: Stack, t: TemplateModule) => stack.templates[stack.templates.findIndex((x) => x.id === t.id) - 1];

/**
 * A module. `compact`: a template under another template, drawn as a slim
 * layer strip (its name and the apps it adds) so a chain of templates stays
 * short; the top template shows the full desktop, inherited apps faded.
 */
/** Where a module stands, as the board draws it: built, built on an older base (an update), not built, or being built. */
export type FaceState = "built" | "update" | "unbuilt" | "building";

const stateClass = (s?: FaceState) => (s && s !== "built" ? ` ${s}` : "");
const StateTag = ({ s }: { s?: FaceState }) =>
  s === "unbuilt" ? (
    <span className="build-tag">Not built</span>
  ) : s === "building" ? (
    <span className="build-tag building">Building…</span>
  ) : s === "update" ? (
    <span className="build-tag update" title="Built on an older base: update it from the stack's Update available">
      Update
    </span>
  ) : null;

export function ModuleFace({ stack, module: m, slots = {}, compact, state }: { stack: Stack; module: Module; slots?: FaceSlots; compact?: boolean; state?: FaceState }) {
  const layer = m.layer;
  const Icon = LAYER_ICON[layer];
  const below = m.layer === "template" ? belowOf(stack, m) : undefined;
  if (compact && m.layer === "template") {
    const adds = below ? m.apps.filter((a) => !below.apps.includes(a)) : m.apps;
    return (
      <div className={`mod mod-template compact${stateClass(state)}`}>
        <div className="mod-bar">
          <span className="mod-layer">
            <Icon size={13} />
          </span>
          {slots.name ?? <span className="mod-name">{m.name}</span>}
          <StateTag s={state} />
          <span className="strip-apps" title={adds.map((a) => app(a)?.name).join(", ")}>
            {below && <span className="strip-plus">+</span>}
            {adds.slice(0, 5).map((a) => (
              <Img key={a} src={app(a)?.icon ?? ""} />
            ))}
            {adds.length > 5 && <span className="strip-more">+{adds.length - 5}</span>}
          </span>
        </div>
      </div>
    );
  }
  const win = slots.win ?? ((sub: AppSub) => <AppSubWindow key={sub.id} sub={sub} />);
  const tray = slots.tray ?? ((sub: CustomSub) => <TrayFace key={sub.id} sub={sub} stack={stack} />);

  return (
    <div className={`mod mod-${layer}${stateClass(state)}`}>
      <div className="mod-bar">
        <span className="mod-layer">
          <Icon size={13} />
          {LAYER_INFO[layer].label}
        </span>
        {slots.name ?? <span className="mod-name">{moduleName(m)}</span>}
        <StateTag s={state} />
        {below && <span className="mod-on">on {below.name}</span>}
        {slots.actions}
      </div>

      {m.layer === "template" && (
        <div className="screen screen-template">
          <div className="desk">
            {m.apps.slice(0, 8).map((id) => {
              const a = app(id);
              return a ? (
                <span key={id} className={`desk-app${below?.apps.includes(id) ? " inherited" : ""}`} title={below?.apps.includes(id) ? `From ${below.name}` : undefined}>
                  <Img src={a.icon} />
                  <span>{a.name}</span>
                </span>
              ) : null;
            })}
            {m.apps.length === 0 && <span className="screen-empty">No apps yet: open it to add some</span>}
          </div>
          <div className="taskbar">
            <Img src="/brand/wadspaces-icon-dark-transparent.svg" className="tb-logo" />
            {m.apps.map((id) => (
              <Img key={id} src={app(id)?.icon ?? ""} className="tb-app" />
            ))}
          </div>
        </div>
      )}

      {m.layer === "extensions" && <ExtensionsScreen stack={stack} subs={m.subs} win={win} blank={slots.blank} />}

      {m.layer === "customization" && <CustomizationScreen stack={stack} subs={m.subs} tray={tray} prompt={slots.prompt} />}
    </div>
  );
}

/** Modules as a stack shows them: top first (the drag ghost uses it). */
export function Pile({ stack, modules }: { stack: Stack; modules: Module[] }) {
  return (
    <div className="pile">
      {[...modules].reverse().map((m) => (
        <ModuleFace key={m.id} stack={stack} module={m} compact={m.layer === "template" && m !== modules.filter((x) => x.layer === "template").at(-1)} />
      ))}
    </div>
  );
}
