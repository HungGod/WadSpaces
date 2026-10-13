// The board's model (data/sync.ts reads it from the documents and writes it
// back). A stack is one wadspace, built from up to three modules, bottom to
// top:
//
//   template       the base image plus apps, in desktop order. Templates
//                  stack too: one built on another has all of its apps and
//                  adds some (Dev + Tiled + LibreSprite builds on Dev).
//   extensions     one submodule per app that has a customization layer
//                  (VS Code extensions, WadBrowser apps, command-line tools).
//                  Optional: a customization can sit right on a template.
//   customization  the look (name, description, background), projects
//                  (cloned or copied in, never mounted) and keys submodules
//
// A stack keeps any number of templates and at most one of each other layer.
// Grabbing a module takes it and every module above it; dropping fills the
// same layers on another stack.

import type { KeyGroup, SecretKind, SignInRef, StackProject, Wallpaper } from "@core/layers";
import { BLANK_WALLPAPER, isBlankWallpaper } from "@/components/desktop/wallpapers";

export type { KeyGroup, SecretKind, Wallpaper };
export type SecretRef = SignInRef;
export { BLANK_WALLPAPER, isBlankWallpaper };

export type Layer = "template" | "extensions" | "customization";
export const LAYERS: Layer[] = ["template", "extensions", "customization"];

export const LAYER_INFO: Record<Layer, { label: string; blurb: string }> = {
  template: { label: "Template", blurb: "The apps" },
  extensions: { label: "Extensions", blurb: "What the apps come set up with" },
  customization: { label: "Customization", blurb: "Name, background, projects and keys" },
};

export interface WebApp {
  id: string;
  name: string;
  url: string;
}

// ── Extensions submodules (one per customizable app) ──

export interface VscodeSub {
  key: "vscode";
  id: string;
  /** The module it was first made in, e.g. "VanuaAcademy Dev". */
  origin: string;
  extensions: string[];
}

export interface BrowserSub {
  key: "wadbrowser";
  id: string;
  origin: string;
  mode: "browser" | "focus";
  webapps: WebApp[];
}

export interface ToolsSub {
  key: "tools";
  id: string;
  origin: string;
  tools: string[];
}

export type AppSub = VscodeSub | BrowserSub | ToolsSub;
export type AppSubKey = AppSub["key"];

// ── Customization submodules ──

export interface LookSub {
  key: "look";
  id: string;
  origin: string;
  name: string;
  description: string;
  wallpaper: Wallpaper;
}

/**
 * A project in a wadspace. Nothing is mounted: a GitHub project is cloned in
 * (and fast-forwarded at start when that's safe), and files from a machine
 * are copied in once. Either way the files live inside the wadspace, at
 * ~/Desktop/<as>.
 */
export type Mount = StackProject;

export interface FoldersSub {
  key: "folders";
  id: string;
  origin: string;
  mounts: Mount[];
}

export interface SecretsSub {
  key: "secrets";
  id: string;
  origin: string;
  /** The keys of everything but WadBrowser: "app:vscode" (its settings), "ext:<id>", "app:obsidian", "app:steam". Left out: no key. */
  bySlot: Record<string, SecretRef>;
  /** WadBrowser's apps, grouped by the key they share. Left out: one group, everything together. */
  groups?: KeyGroup[];
}

export type CustomSub = LookSub | FoldersSub | SecretsSub;
export type CustomSubKey = CustomSub["key"];

export type AnySub = AppSub | CustomSub;

// ── Modules ──

export interface TemplateModule {
  layer: "template";
  id: string;
  /** The template document it is (none yet: a new one, made when it's saved). */
  ref?: string;
  name: string;
  description: string;
  /** Catalog app ids, in desktop order. */
  apps: string[];
}

export interface ExtensionsModule {
  layer: "extensions";
  id: string;
  /** The Extensions document it is (none yet: made when it's saved). */
  ref?: string;
  name: string;
  subs: AppSub[];
  /** What opens at boot ("app:<id>", "web:<id>"), kept as the document has it. */
  autostart?: string[];
}

export interface CustomizationModule {
  layer: "customization";
  id: string;
  subs: CustomSub[];
}

export type Module = TemplateModule | ExtensionsModule | CustomizationModule;

export interface Stack {
  id: string;
  /** Bottom first; each builds on the one below. */
  templates: TemplateModule[];
  extensions?: ExtensionsModule;
  customization?: CustomizationModule;
}

/** The top template: the apps the wadspace's image ends up with. */
export const topTemplate = (s: Stack): TemplateModule | undefined => s.templates[s.templates.length - 1];
export const appsOf = (s: Stack) => topTemplate(s)?.apps ?? [];

/** Every module in the stack, bottom to top. */
export const modulesOf = (s: Stack): Module[] => [...s.templates, ...(s.extensions ? [s.extensions] : []), ...(s.customization ? [s.customization] : [])];

const appNames = (ids: string[], name: (id: string) => string) => ids.map(name).join(", ");

/** Whether template `upper` can build on `lower`: it has all of lower's apps and adds at least one. */
export function buildsOn(upper: TemplateModule, lower: TemplateModule, name: (id: string) => string): { ok: boolean; why?: string } {
  const missing = lower.apps.filter((a) => !upper.apps.includes(a));
  if (missing.length) return { ok: false, why: `${upper.name} can't build on ${lower.name}: it doesn't have ${appNames(missing, name)}` };
  if (upper.apps.length === lower.apps.length) return { ok: false, why: `${upper.name} adds no apps to ${lower.name}` };
  return { ok: true };
}

/** Where templates (bottom first) fit into a chain of templates: the highest place they build on what's below and what's above builds on them. */
export function fitTemplates(chain: TemplateModule[], adding: TemplateModule[], name: (id: string) => string): { ok: true; at: number } | { ok: false; why: string } {
  let first: string | undefined;
  for (let at = chain.length; at >= 0; at--) {
    const below = chain[at - 1];
    const above = chain[at];
    const v1 = below ? buildsOn(adding[0], below, name) : { ok: true };
    const v2 = above ? buildsOn(above, adding[adding.length - 1], name) : { ok: true };
    if (v1.ok && v2.ok) return { ok: true, at };
    first ??= v1.why ?? v2.why;
  }
  return { ok: false, why: first ?? "Doesn't fit" };
}

/** Something dropped in the Delete bucket, kept to drag back out. */
export type Deleted =
  | { what: "module"; id: string; module: Module; from: string; at: number }
  | { what: "sub"; id: string; sub: AnySub; from: string; at: number };

let n = 0;
export const uid = (p: string) => `${p}-${Date.now().toString(36)}-${(n++).toString(36)}`;

export const subParent = (key: AnySub["key"]): "extensions" | "customization" =>
  key === "vscode" || key === "wadbrowser" || key === "tools" ? "extensions" : "customization";

export const subOf = <K extends AnySub["key"]>(m: ExtensionsModule | CustomizationModule | undefined, key: K) =>
  (m?.subs as AnySub[] | undefined)?.find((x) => x.key === key) as Extract<AnySub, { key: K }> | undefined;
export const lookOf = (s: Stack) => subOf(s.customization, "look");

/** A module's name: a customization's is its look's. */
export const moduleName = (m: Module) => (m.layer === "customization" ? (subOf(m, "look")?.name || "Untitled") : m.name);

/** The stack's display name: its customization's, else what's below. */
export const stackName = (s: Stack) => lookOf(s)?.name || s.extensions?.name || topTemplate(s)?.name || "Loose modules";

/** A module nothing's been put in yet: the editor's starting point, replaced by whatever's dropped on it. */
export const isBlank = (m: Module) =>
  m.layer === "template"
    ? !m.apps.length
    : m.layer === "extensions"
      ? !m.subs.length
      : !subOf(m, "look")?.name.trim() && isBlankWallpaper(subOf(m, "look")?.wallpaper) && !subOf(m, "folders")?.mounts.length && !Object.keys(subOf(m, "secrets")?.bySlot ?? {}).length && !subOf(m, "secrets")?.groups?.some((g) => g.key);

const SETUP_APP: Partial<Record<AppSubKey, { id: string; name: string }>> = { vscode: { id: "vscode", name: "VS Code" }, wadbrowser: { id: "wadbrowser", name: "WadBrowser" } };

/** App setups in the stack's Extensions for apps its template doesn't have. */
export function strayApps(s: Stack): string[] {
  const apps = appsOf(s);
  return (s.extensions?.subs ?? []).map((x) => SETUP_APP[x.key]).filter((a): a is { id: string; name: string } => !!a && !apps.includes(a.id)).map((a) => a.name);
}

/** What a stack still needs before it can be built. */
export function missingFor(s: Stack): string[] {
  const out: string[] = [];
  if (!s.templates.length) out.push("a template");
  else if (!appsOf(s).length) out.push("an app in the template");
  else for (const a of strayApps(s)) out.push(`${a} in the template (its Extensions set it up)`);
  if (!s.customization) out.push("a customization");
  else if (!lookOf(s)?.name.trim()) out.push("a name");
  return out;
}

export type StackStatus = "ready" | "no-template" | "no-customization";
export const statusOf = (s: Stack): StackStatus => (!s.templates.length ? "no-template" : !s.customization ? "no-customization" : "ready");

/** Copies with new ids, so a clone never shares a module with its source. */
export function cloneModule<M extends Module>(m: M, rename = true): M {
  const copy = structuredClone(m) as M;
  copy.id = uid(m.layer);
  if ("subs" in copy) copy.subs = copy.subs.map(cloneSub) as never;
  if (rename) {
    if (copy.layer === "customization") {
      const look = subOf(copy, "look");
      if (look) look.name = `${look.name} copy`;
    } else copy.name = `${copy.name} copy`;
  }
  return copy;
}

export function cloneSub<S extends AnySub>(s: S): S {
  const copy = structuredClone(s);
  copy.id = uid(s.key);
  return copy;
}
