// The Builder's three layers, and the rules between them: wad-core's
// crates/wad-core/src/layers.rs, run as WebAssembly. Each layer builds on the
// one before:
//
//   Template       the base image plus one or more apps. Its own image,
//                  localhost/wadspaces-template-<id>:latest, FROM the base.
//   Customization  a template's apps set up: WadBrowser's mode and web apps,
//                  VS Code's extensions, tools, what opens at boot. Its own
//                  image, localhost/wadspaces-custom-<id>:latest, FROM the
//                  template's.
//   Wadspace       a template or customization made into a space: name,
//                  wallpaper, project folders and secrets (saved sign-ins).
//                  No image of its own: wadd mounts those when it starts.
import type { Wallpaper } from "./model";
import { call } from "./wasm";

/** A saved sign-in's kind: a secret only fits a slot of its kind. */
export type SecretKind = "web" | "obsidian" | "steam" | "vscode-claude-code" | "vscode-codex";

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

export interface Customization extends Setup {
  id: string;
  owner: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

/** Where a wadspace comes from. */
export interface BaseRef {
  kind: "template" | "customization";
  id: string;
}

/** A wadspace: no image of its own; its wallpaper, projects and secrets are mounted at start. */
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
  /** Migrated from before the layers: it runs this old image until its layers are built. */
  legacyImage?: string | null;
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
  customizations: Customization[];
}

export interface Stack {
  template: Template;
  /** Its customizations, oldest first, each with the wadspaces built on it. */
  customizations: { customization: Customization; wadspaces: WadspaceV2[] }[];
  /** Wadspaces built on the template itself. */
  wadspaces: WadspaceV2[];
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

/** A wadspace from before the layers, as the layers. */
export interface Migrated {
  template: Template;
  newTemplate: boolean;
  customization: Customization | null;
  wadspace: WadspaceV2;
  leftOut: string[];
  chromeApps: string[];
  /** What couldn't come across, to tell the user once (or null). */
  notice: string | null;
}

/** The kinds a slot can keep. */
export const signInKinds = (): SecretKind[] => call("signInKinds");

export const emptySetup = (templateId: string): Setup => call("emptySetup", templateId);
/** Just the setup part of a customization. */
export const setupOf = (c: Partial<Setup>): Setup => call("setupOf", c);
export const sameSetup = (a: Partial<Setup>, b: Partial<Setup>): boolean => call("sameSetup", a, b);
/** A web app's id from its name: "Google Cloud" → "google-cloud". */
export const webappId = (name: string): string => call("webappId", name);
/** A web app's icon: bundled for a site the catalog knows, else the site's favicon. */
export const webappIcon = (url: string): string => call("webappIcon", url);
export const imageKey = (base: BaseRef): LayerKey => call("imageKey", base);
export const imageRef = (key: LayerKey): string => call("imageRef", key);

/** What a base has, with its template, or null when either is gone. */
export const resolve = (lib: Library, base: BaseRef): { template: Template; setup: Setup; customization?: Customization } | null =>
  call("resolve", lib, base);

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
/** Who uses each saved sign-in, by its id. */
export const secretUse = (wadspaces: WadspaceV2[], browsers: BrowserSetup[]): Record<string, SecretUser[]> => call("secretUse", wadspaces, browsers);

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

export const templateDockerfile = (t: Template): string => call("templateDockerfile", t);
export const customizationDockerfile = (c: Customization, t: Template): string => call("customizationDockerfile", c, t);
/** A template's build folder and the sha its image is labelled with. */
export const templateLayer = (t: Template): Layer => call("templateLayer", t);
/** A customization's build folder (FROM its template's image) and its sha. */
export const customizationLayer = (c: Customization, t: Template): Layer => call("customizationLayer", c, t);
/** "jpg" for a JPEG picture, else "png": how wadd stores the wallpaper. */
export const wallpaperExt = (w: Wallpaper): "png" | "jpg" => call("wallpaperExt", w);
/** What wadd mounts when the wadspace starts, for the Image tab. */
export const runSummary = (
  w: Pick<WadspaceV2, "wallpaper" | "projects" | "secrets">,
  projects: { id: string; name: string; mountName: string }[],
  slots: Slot[],
): string[] => call("runSummary", w, projects, slots);
/** The wadd workspace a wadspace installs as (its image, env, /config, sign-ins). */
export const workspaceFor = (w: WadspaceV2, template: Template, setup: Setup, opts: { tz?: string; secrets?: string[] }): Record<string, unknown> =>
  call("workspaceFor", w, template, setup, opts);

/** Web apps used anywhere already, to add in a click. */
export const knownWebapps = (customizations: Setup[], browsers: { webapps: WebApp[] }[]): WebApp[] => call("knownWebapps", customizations, browsers);
/** Whether a name is taken in this list (but `except`). */
export const named = (name: string, taken: { name: string; id?: string }[], except?: string): boolean =>
  call("named", name, taken, ...(except ? [except] : []));
/** Each template with what's built on it (deleted ones left out). */
export const stacks = (lib: Library & { wadspaces: WadspaceV2[] }): Stack[] => call("stacks", lib);
/** A template or customization name already in use (but `except`). */
export const nameTaken = (name: string, lib: Library, except?: string): boolean => call("nameTaken", name, lib, ...(except ? [except] : []));

/** What another setup has to bring into this template, and why parts don't fit. */
export const importable = (from: Setup, template: Template): Record<ImportPart, { count: number; ok: boolean; why?: string }> =>
  call("importable", from, template);
/** `into` with the chosen parts of `from` merged in. */
export const importInto = (into: Setup, from: Setup, template: Template, parts: ImportPart[]): Setup => call("importInto", into, from, template, parts);

/** A wadspace from before the layers (a v1 design) as a template, a customization and a v2 wadspace. */
export const migrateWadspaceV1 = (
  v1: { id: string; name: string; description: string; layout: unknown; advanced?: unknown; updatedAt?: string },
  lib: Library,
  opts: { owner: string; now: string; signins: { id: string; name: string; app: string }[]; legacyImage: string | null; projects?: string[] },
): Migrated => call("migrateWadspaceV1", v1, lib, opts);
