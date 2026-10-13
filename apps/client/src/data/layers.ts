// The Builder's layers as the backends handle them (no Firebase or wadd
// here, so the three backends and the tests share it):
//
//   - the layer images on a machine (wadd's GET /v1/images, or a heartbeat)
//     and how each stands: Not built, Building, Built, or Changed since built
//     (its build folder's sha differs, or what it's built on was rebuilt since);
//   - what the launcher starts (RunItem) as wadd launches it (LaunchItem),
//     with a throwaway run's wallpaper drawn here;
//   - what installing a wadspace (a stack) on a machine sends
//     (PUT /v1/wadspaces/{id}), and what building a layer does (its templates
//     below it, bottom first).
import {
  chainOf,
  extensionsLayer,
  resolveStack,
  stackImageKey,
  templateLayer,
  workspaceFor,
  type BrowserSetup,
  type Extensions,
  type LayerKey,
  type Library,
  type SignInRef,
  type StackKeys,
  type Template,
  type Wadspace,
  type Wallpaper,
  type WebApp,
} from "@core/layers";

import { appById, extensionById } from "@core/catalog/catalog";
import { renderWallpaper } from "@/lib/wallpaperRender";

/** A layer's image on a machine. */
export interface ImageRow {
  layer: LayerKey;
  ref: string;
  /** podman's id. */
  id: string;
  dockerfileSha: string;
  /** Unix seconds. */
  builtAt: number;
  sizeMb: number;
  /** The id of the image it was built FROM, as it was then. */
  from: string;
}

export type ImageState = "never" | "building" | "built" | "changed";

/**
 * How a layer's image stands on the machine: built from the layer as it is
 * now, on what's under it as that is now (a template on its parent's image,
 * an Extensions layer on its template's), all the way down. A template on
 * the base is taken as built on it (the base comes on the update drive).
 */
export function imageState(key: LayerKey, lib: Library, images: Partial<Record<LayerKey, ImageRow>>, building: ReadonlySet<string>): ImageState {
  if (building.has(key)) return "building";
  const row = images[key];
  if (!row) return "never";
  const under = (parentKey: LayerKey | null, sha: string): ImageState => {
    if (row.dockerfileSha !== sha) return "changed";
    if (!parentKey) return "built";
    const parent = images[parentKey];
    if (!parent || parent.id !== row.from) return "changed";
    const p = imageState(parentKey, lib, images, building);
    return p === "built" ? "built" : "changed";
  };
  if (key.startsWith("template:")) {
    const t = lib.templates.find((x) => x.id === key.slice(9));
    if (!t) return "built";
    const chain = chainOf(lib, t.id);
    const parent = chain.length > 1 ? chain[chain.length - 2] : null;
    return under(parent ? `template:${parent.id}` : null, templateLayer(t, parent).sha);
  }
  const e = lib.extensions.find((x) => x.id === key.slice(7));
  const t = e && lib.templates.find((x) => x.id === e.templateId);
  if (!e || !t) return "built";
  return under(`template:${t.id}`, extensionsLayer(e, t).sha);
}

/** The image rows by layer. */
export const byLayer = (rows: ImageRow[]): Partial<Record<LayerKey, ImageRow>> => Object.fromEntries(rows.map((r) => [r.layer, r]));

/** What a throwaway run has instead of its wadspace's own: its background, and keys by slot. */
export interface RunOverrides {
  wallpaper: Wallpaper;
  /** Its keys by slot ("app:<id>", "ext:<id>"); WadBrowser's groups are its wadspace's. */
  bySlot: Record<string, SignInRef>;
}

/** A WadBrowser to launch: one of the machine's own (WadBrowser, WadBrowser
 *  Focus), or a setup (saved, or a run of its own). */
export interface BrowserConfig {
  id: string;
  name: string;
  mode: "browser" | "focus";
  webapps: WebApp[];
  secrets: Record<string, SignInRef>;
}

/** What the launcher starts. Wadspaces are spaces; WadBrowsers and the
 *  terminal run on the machine beside them. */
export type RunItem =
  | { kind: "wadspace"; wadspaceId: string; overrides?: RunOverrides }
  | { kind: "browser"; config: BrowserConfig; savedId?: string }
  | { kind: "terminal" };

/** The two WadBrowsers every machine has (wadd's `browser` and `browser-focus` apps). */
export const DEFAULT_BROWSERS: BrowserConfig[] = [
  { id: "wadbrowser", name: "WadBrowser", mode: "browser", webapps: [], secrets: {} },
  { id: "wadbrowser-focus", name: "WadBrowser Focus", mode: "focus", webapps: [], secrets: {} },
];

/** wadd's own app for a default WadBrowser. */
export const DEFAULT_BROWSER_APPS: Record<string, string> = { wadbrowser: "browser", "wadbrowser-focus": "browser-focus" };

/** A WadBrowser setup's sign-ins as wadd mounts them: each web app's, by slot. */
export function browserSignIns(secrets: Record<string, SignInRef>) {
  return Object.entries(secrets).map(([slot, r]) => ({ id: r.id, app: slot.replace(/^web:/, ""), web: true, name: r.name, kind: r.kind, slot }));
}

/** A wallpaper as wadd takes it: drawn here (gradients and colours too). */
export async function wallpaperUpload(w: Wallpaper): Promise<{ ext: "png" | "jpg"; data: string }> {
  const { blob, fileName } = await renderWallpaper(w);
  return { ext: fileName.endsWith(".jpg") ? "jpg" : "png", data: base64(new Uint8Array(await blob.arrayBuffer())) };
}

function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** wadd's LaunchItem for what the launcher starts. A run's sign-ins are its
 *  wadspace's with the run's keys by slot, as wad-core installs them. */
export async function launchItem(item: RunItem, opts: { background: boolean; lib: Library & { wadspaces: Wadspace[] } }): Promise<Record<string, unknown>> {
  const { background } = opts;
  if (item.kind === "terminal") return { kind: "terminal", background };
  if (item.kind === "browser") {
    const c = item.config;
    const plain = DEFAULT_BROWSER_APPS[c.id];
    if (plain && !item.savedId && !c.webapps.length) return { kind: "workspace", workspace: plain, background };
    const setup = { name: c.name, mode: c.mode, webapps: c.webapps, signins: browserSignIns(c.secrets) };
    return { kind: "browser", setup, ...(item.savedId && { savedId: item.savedId }), background };
  }
  if (!item.overrides) return { kind: "workspace", workspace: item.wadspaceId, background };
  const o = item.overrides;
  const w = opts.lib.wadspaces.find((x) => x.id === item.wadspaceId);
  const r = w && resolveStack(opts.lib, w);
  const keys: StackKeys = { ...w?.customization?.secrets, bySlot: o.bySlot };
  const signins = w?.customization && r ? workspaceFor({ ...w, customization: { ...w.customization, secrets: keys } }, r.template, r.setup, {}).signins : [];
  return { kind: "run", from: item.wadspaceId, overrides: { wallpaper: await wallpaperUpload(o.wallpaper), signins }, background };
}

/** Why a stack can't be installed or built yet, or null. */
export function notReady(w: Wadspace, lib: Library): string | null {
  if (!w.template) return "It needs a template with apps.";
  if (!resolveStack(lib, w)) return "Its template is gone.";
  if (!w.customization) return "It needs a customization.";
  if (!w.customization.name.trim()) return "Its customization needs a name.";
  return null;
}

/** PUT /v1/wadspaces/{id}: the stack and the layers it's on. */
export function installBody(w: Wadspace, lib: Library, tz: string) {
  const r = resolveStack(lib, w);
  if (!r) throw new Error(`${w.customization?.name || "That wadspace"}'s template is gone.`);
  return { wadspace: w, template: r.template, extensions: r.extensions ?? null, tz };
}

/** The layer build request: a template's (with the templates it builds on), or an
 *  Extensions layer's (its template and those under it with it). */
export function layerRequest(key: LayerKey, lib: Library): { layer: LayerKey; template: Template; parents: Template[]; extensions: Extensions | null } {
  const on = (tid: string) => {
    const chain = chainOf(lib, tid);
    if (!chain.length) throw new Error("That template is gone.");
    return { template: chain[chain.length - 1], parents: chain.slice(0, -1) };
  };
  if (key.startsWith("template:")) return { layer: key, ...on(key.slice(9)), extensions: null };
  const extensions = lib.extensions.find((c) => c.id === key.slice(7));
  if (!extensions) throw new Error("Those Extensions are gone.");
  return { layer: key, ...on(extensions.templateId), extensions };
}

/** The image a stack runs on, or null without a template. */
export const layerOf = (w: Pick<Wadspace, "template" | "extensions">): LayerKey | null => stackImageKey(w) || null;

/** A stack's name: its customization's, else what's under it. */
export const wadspaceName = (w: Wadspace, lib?: Library) =>
  w.customization?.name.trim() ||
  (lib && w.extensions && lib.extensions.find((e) => e.id === w.extensions)?.name) ||
  (lib && w.template && lib.templates.find((t) => t.id === w.template)?.name) ||
  w.draftTemplate?.name ||
  "Untitled";

/** Something that uses a saved sign-in: a stack (by a slot or a WadBrowser
 *  key group), or a WadBrowser setup; `what` in it, e.g. "Claude Code" or
 *  "WadBrowser, Gmail". */
export interface KeyUser {
  kind: "wadspace" | "browser";
  id: string;
  name: string;
  what: string;
}

/** Who uses each saved sign-in, by its id (deleted ones left out). */
export function keyUse(lib: Library & { wadspaces: Wadspace[]; browsers: BrowserSetup[] }): Record<string, KeyUser[]> {
  const out: Record<string, KeyUser[]> = {};
  const add = (id: string, u: KeyUser) => (out[id] ??= []).push(u);
  const slotName = (slot: string) => {
    const [kind, id] = slot.split(/:(.*)/s);
    return kind === "ext" ? extensionById(id).name : (appById(id)?.name ?? id);
  };
  for (const w of lib.wadspaces.filter((x) => !x.deletedAt && x.customization)) {
    const keys = w.customization!.secrets;
    const name = wadspaceName(w);
    for (const [slot, r] of Object.entries(keys.bySlot)) add(r.id, { kind: "wadspace", id: w.id, name, what: slotName(slot) });
    const webapps = resolveStack(lib, w)?.setup.webapps ?? [];
    for (const g of keys.groups ?? []) {
      if (!g.key || !g.members.length) continue;
      const what = g.members.map((m) => (m === "browser" ? "WadBrowser" : (webapps.find((x) => `web:${x.id}` === m)?.name ?? m.replace(/^web:/, "")))).join(", ");
      add(g.key.id, { kind: "wadspace", id: w.id, name, what });
    }
  }
  for (const b of lib.browsers.filter((x) => !x.deletedAt)) {
    for (const [slot, r] of Object.entries(b.secrets)) add(r.id, { kind: "browser", id: b.id, name: b.name, what: b.webapps.find((x) => `web:${x.id}` === slot)?.name ?? slot });
  }
  return out;
}

/** Saved setups' fields a WadBrowser launch carries. */
export const configOf = (b: BrowserSetup): BrowserConfig => ({ id: b.id, name: b.name, mode: b.mode, webapps: b.webapps, secrets: b.secrets });

/** What the client's time zone is (a wadspace's clock). */
export const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "Etc/UTC";
