// The Builder's layers, and the rules between them: wad-core's
// crates/wad-core/src/layers.rs, run as WebAssembly. A wadspace is a stack,
// each layer building on the one below:
//
//   Template       the base image plus apps. Its own image,
//                  localhost/wadspaces-template-<id>:latest, FROM the base, or
//                  FROM its `parent` template's (whose apps it all has, and more).
//   Extensions     a template's apps set up: WadBrowser's mode and web apps,
//                  VS Code's extensions, tools, what opens at boot. Its own
//                  image, FROM the template's (still keyed "custom:<id>",
//                  localhost/wadspaces-custom-<id>:latest).
//   Customization  the wadspace's own: name, wallpaper, projects and keys
//                  (saved sign-ins). No image: wadd hands them over at start.

import { call } from "./wasm";

/** A wadspace's background: a gradient or colour (CSS), or a picture (a URL). */
export interface Wallpaper {
  type: "gradient" | "image" | "color";
  value: string;
}

/** A saved sign-in's kind: a secret only fits a slot of its kind. */
export type SecretKind = "web" | "vscode" | "obsidian" | "steam" | "vscode-claude-code" | "vscode-codex";

/** A saved sign-in a slot uses: the machine's id, plus its name and kind, so
 *  a machine that doesn't have it yet can make it (wadd does, at launch). */
export interface SignInRef {
  id: string;
  name: string;
  kind: SecretKind;
}

export interface WebApp {
  id: string;
  name: string;
  url: string;
}

/** The base image plus apps. Always the user's own; `starter`: made from starters.json. */
export interface Template {
  id: string;
  owner: string;
  name: string;
  description: string;
  /** App ids (catalog.json's, or an old app a migrated template kept), in desktop order. */
  apps: string[];
  /** The template it builds on: all of its apps are in `apps` (first, in its order), plus more. */
  parent?: string;
  starter?: true;
  createdAt: string;
  updatedAt: string;
  /** Deleted, not for good: listed under "Recently deleted". */
  deletedAt?: string;
}

/** What a customization sets on its template; a template alone has emptySetup's. */
export interface Setup {
  templateId: string;
  /** WadBrowser: with an address bar, or Focus (none). */
  browserMode: "browser" | "focus";
  /** WadBrowser web apps, each its own window and desktop icon. */
  webapps: WebApp[];
  /** VS Code extensions (marketplace ids). */
  extensions: string[];
  /** Command-line tools (catalog tools, features). */
  tools: string[];
  /** What opens when the wadspace boots: "app:<id>" or "web:<id>". */
  autostart: string[];
}

/** An Extensions layer: a template's apps set up (its `templateId`). */
export interface Extensions extends Setup {
  id: string;
  owner: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

/** Where a version 2 wadspace came from (its template, or what's now an Extensions layer). */
export interface BaseRef {
  kind: "template" | "customization";
  id: string;
}

/** A wadspace from before stacks (version 2): read once, to move it to one (migrateV2). */
export interface WadspaceV2 {
  version: 2;
  id: string;
  owner: string;
  name: string;
  description: string;
  base: BaseRef;
  wallpaper: Wallpaper;
  /** Project ids, mounted at ~/Desktop/<mount>. */
  projects: string[];
  /** The sign-in per slot ("web:<id>", "ext:<id>", "app:<id>"); a slot left out keeps nothing ("Don't save"). */
  secrets: Record<string, SignInRef>;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

/** Some of WadBrowser's apps sharing one key (a profile): the browser itself ("browser") and web apps ("web:<id>"). */
export interface KeyGroup {
  id: string;
  members: string[];
  key?: SignInRef;
}

/** A wadspace's keys: by slot ("app:<id>", "ext:<id>"), and WadBrowser's groups (left out: one group, no key). */
export interface StackKeys {
  bySlot: Record<string, SignInRef>;
  groups?: KeyGroup[];
}

/**
 * A project in a wadspace: nothing is mounted. A GitHub repo is cloned into
 * it (and fast-forwarded at start when that's safe); files from a machine
 * are copied in once. Either way it's at ~/Desktop/<as>.
 */
export type StackProject =
  | { id: string; kind: "github"; repo: string; ref?: string; as: string; setup?: string }
  | {
      id: string;
      kind: "copy";
      /** Where it was copied from: paths on a machine, or on a drive (from before copies). */
      source: { machineId?: string; drive?: { uuid: string; label: string; fstype: string }; paths: string[] };
      as: string;
      /** What was copied (not yet, for one from before copies: copied at its first start). */
      files?: number;
      bytes?: number;
    };

/** A wadspace's own layer. */
export interface StackCustomization {
  name: string;
  description: string;
  wallpaper: Wallpaper;
  projects: StackProject[];
  secrets: StackKeys;
}

/** A wadspace: a stack of a template (the top of its chain), maybe Extensions, and its Customization. */
export interface Wadspace {
  version: 3;
  id: string;
  owner: string;
  sharedWith?: string[];
  /** Left to right on the Builder's board. */
  order: number;
  /** The top template; what it builds on follows its `parent`. */
  template?: string;
  /** A template with no apps yet (one can't be saved empty): the board's blank template. */
  draftTemplate?: { name: string; description: string };
  /** Its Extensions layer, made on `template`. */
  extensions?: string;
  /** Extensions with no template under them yet (the board's), kept here until there is one. */
  draftExtensions?: { name: string } & Omit<Setup, "templateId">;
  customization?: StackCustomization;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

/** A WadBrowser setup, launched on the machine beside the spaces. */
export interface BrowserSetup {
  id: string;
  owner: string;
  name: string;
  mode: "browser" | "focus";
  webapps: WebApp[];
  /** The sign-in per web app ("web:<id>"); left out: not saved. */
  secrets: Record<string, SignInRef>;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

/** A layer's image: a template's or a customization's. */
export type LayerKey = `template:${string}` | `custom:${string}`;

/** Something in a wadspace that can keep a sign-in. */
export interface Slot {
  key: string;
  kind: SecretKind;
  /** What it is, e.g. "GitHub (web app)". */
  label: string;
  /** Names a new secret: <wadspace>-<appId>. */
  appId: string;
  iconUrl: string;
}

export interface DesktopItem {
  /** "app:<id>", "web:<id>" or "project:<id>". */
  id: string;
  label: string;
  iconUrl: string;
  project?: boolean;
  /** VS Code with extensions added: how many (the mock images mark it with a +). */
  added?: number;
}

export interface MenuApp {
  key: string;
  name: string;
  iconUrl: string;
}

export interface MenuCategory {
  name: string;
  apps: MenuApp[];
}

export interface Library {
  templates: Template[];
  extensions: Extensions[];
}

/** What a stack is built from: its chain of templates (bottom first; the top one its `template`), and its setup. */
export interface Resolved {
  chain: Template[];
  template: Template;
  setup: Setup;
  extensions?: Extensions;
}

/** The workspace a stack installs as (wad-core's workspace_for): enough of it to read its sign-ins. */
export interface WaddWorkspace {
  id: string;
  name: string;
  image: string;
  signins: { id: string; app: string; web?: boolean; name: string; kind: string; slot: string }[];
  [k: string]: unknown;
}

/** A layer's build folder, as wadd builds it. `sha` labels the built image. */
export interface Layer {
  key: LayerKey;
  ref: string;
  /** The image it's built FROM. */
  from: string;
  files: { path: string; content: string }[];
  sha: string;
}

export type ImportPart = "webapps" | "extensions" | "tools" | "autostart" | "browserMode";

export const IMPORT_PARTS: { part: ImportPart; label: string }[] = [
  { part: "webapps", label: "Web apps" },
  { part: "extensions", label: "VS Code extensions" },
  { part: "tools", label: "Tools" },
  { part: "autostart", label: "Open at boot" },
  { part: "browserMode", label: "WadBrowser mode" },
];

/** Who uses a saved sign-in. */
export interface SecretUser {
  kind: "wadspace" | "browser";
  id: string;
  name: string;
  slot: string;
}

/** The kinds a slot can keep. */
export const signInKinds = (): SecretKind[] => call("signInKinds");

export const emptySetup = (templateId: string): Setup => call("emptySetup", templateId);
/** Just the setup part of an Extensions layer. */
export const setupOf = (c: Partial<Setup>): Setup => call("setupOf", c);
export const sameSetup = (a: Partial<Setup>, b: Partial<Setup>): boolean => call("sameSetup", a, b);
/** A web app's id from its name: "Google Cloud" → "google-cloud". */
export const webappId = (name: string): string => call("webappId", name);
/** A web app's icon: bundled for a site the catalog knows, else the site's favicon. */
export const webappIcon = (url: string): string => call("webappIcon", url);
export const imageRef = (key: LayerKey): string => call("imageRef", key);

/** The sign-ins a template with this setup can keep, in desktop order. */
export const slotsFor = (template: Template, setup: Setup): Slot[] => call("slotsFor", template, setup);
/** A WadBrowser setup's sign-ins: one per web app. */
export const browserSlots = (setup: { webapps: WebApp[] }): Slot[] => call("browserSlots", setup);
/** A new secret's name: <wadspace name without spaces>-<app id>. */
export const newSecretName = (wadspaceName: string, slot: Slot): string => call("newSecretName", wadspaceName, slot);
/** A new sign-in's name in a WadBrowser setup: <setup>-WadBrowser-<App>, or WadSpaces-WadBrowser.<App> unnamed. */
export const defaultBrowserSecretName = (setupName: string, slot: Slot): string => call("defaultBrowserSecretName", setupName, slot);
/** Whether a secret can go in a slot (only its own kind). */
export const fits = (secret: { kind: string }, slot: { kind: string }): boolean => call("fits", secret, slot);
export const kindOfSlotKey = (key: string): SecretKind | null => call("kindOfSlotKey", key);

/** Whether anything in the template opens folders in a window (else projects get no desktop icon). */
export const opensFolders = (template: Template): boolean => call("opensFolders", template);
/** The desktop the image draws: apps, then web apps, then project folders (where something opens them). */
export const desktopFor = (template: Template, setup: Setup, projects: { id: string; name: string }[] = []): DesktopItem[] =>
  call("desktopFor", template, setup, projects);
/** selkies-desktop's Start menu: every launcher in the image, by category. */
export const startMenuFor = (template: Template, setup: Setup): MenuCategory[] => call("startMenuFor", template, setup);
/** What can open at boot: the template's apps and the web apps. */
export const bootables = (template: Template, setup: Setup): { key: string; name: string; iconUrl: string }[] => call("bootables", template, setup);
/** /etc/wadspaces/layout.json for a template with this setup. */
export const layoutJsonFor = (template: Template, setup: Setup): string => call("layoutJsonFor", template, setup);
/** A marketplace id (publisher.name). */
export const isExtensionId = (id: string): boolean => call("isExtensionId", id);

/** A template's Dockerfile: FROM its parent's image (null: the base), adding its own apps. */
export const templateDockerfile = (t: Template, parent: Template | null = null): string => call("templateDockerfile", t, parent);
export const extensionsDockerfile = (c: Extensions, t: Template): string => call("extensionsDockerfile", c, t);
/** A template's build folder and the sha its image is labelled with. */
export const templateLayer = (t: Template, parent: Template | null = null): Layer => call("templateLayer", t, parent);
/** An Extensions layer's build folder (FROM its template's image) and its sha. */
export const extensionsLayer = (c: Extensions, t: Template): Layer => call("extensionsLayer", c, t);

/** A template and what it builds on, bottom first. */
export const chainOf = (lib: { templates: Template[] }, templateId: string): Template[] => call("chainOf", lib, templateId);
/** Why a chain (bottom first) can't be built, or null. */
export const chainOk = (chain: Template[]): string | null => call("chainOk", chain);
/** What a stack is built from, or null with no template. */
export const resolveStack = (lib: Library, w: Pick<Wadspace, "template" | "extensions">): Resolved | null => call("resolveStack", lib, w);
/** The image a stack runs: its Extensions', else its template's ("" with neither). */
export const stackImageKey = (w: Pick<Wadspace, "template" | "extensions">): LayerKey | "" => call("stackImageKey", w);
/** WadBrowser's apps that keep keys: "browser" and "web:<id>" (none without WadBrowser). */
export const keyItems = (template: Template, setup: Setup): string[] => call("keyItems", template, setup);
/** WadBrowser's key groups, tidied (apps in no group join the first with members). */
export const keyGroupsOf = (template: Template, setup: Setup, groups: KeyGroup[] | undefined): KeyGroup[] =>
  call("keyGroupsOf", template, setup, groups ?? null);
/** A version 2 wadspace as a stack (others come back as they are); `order` is the caller's. `lib`:
 *  the documents as they were (`customizations`: the Extensions layers). */
export const migrateV2 = (
  w: WadspaceV2 | Wadspace,
  lib: { templates: Template[]; customizations: Extensions[] },
  projects: { id: string; name: string; mountName: string; setup: string; source: unknown }[],
): Omit<Wadspace, "order"> & { order?: number } => call("migrateV2", w, lib, projects);
/** "jpg" for a JPEG picture, else "png": how wadd stores the wallpaper. */
export const wallpaperExt = (w: Wallpaper): "png" | "jpg" => call("wallpaperExt", w);
/** The wadd workspace a wadspace installs as (its image, env, /config, sign-ins). */
export const workspaceFor = (w: Wadspace, template: Template, setup: Setup, opts: { tz?: string; secrets?: string[] }): WaddWorkspace =>
  call("workspaceFor", w, template, setup, opts);

/** Web apps used anywhere already, to add in a click. */
export const knownWebapps = (extensions: Setup[], browsers: { webapps: WebApp[] }[]): WebApp[] => call("knownWebapps", extensions, browsers);
/** Whether a name is taken in this list (but `except`). */
export const named = (name: string, taken: { name: string; id?: string }[], except?: string): boolean =>
  call("named", name, taken, ...(except ? [except] : []));

/** What another setup has to bring into this template, and why parts don't fit. */
export const importable = (from: Setup, template: Template): Record<ImportPart, { count: number; ok: boolean; why?: string }> =>
  call("importable", from, template);
/** `into` with the chosen parts of `from` merged in. */
export const importInto = (into: Setup, from: Setup, template: Template, parts: ImportPart[]): Setup => call("importInto", into, from, template, parts);
