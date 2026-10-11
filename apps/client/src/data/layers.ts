// The Builder's layers as the backends handle them (no Firebase or wadd
// here, so the three backends and the tests share it):
//
//   - the layer images on a machine (wadd's GET /v1/images, or a heartbeat)
//     and how each stands: Not built, Building, Built, or Changed since built
//     (its build folder's sha differs, or its template's image was rebuilt
//     since it was built on it);
//   - what the launcher starts (RunItem) as wadd launches it (LaunchItem),
//     with a throwaway run's wallpaper drawn here;
//   - what installing a wadspace on a machine sends (PUT /v1/wadspaces/{id}).
import {
  customizationLayer,
  imageKey,
  resolve,
  templateLayer,
  type BaseRef,
  type BrowserSetup,
  type Customization,
  type LayerKey,
  type Library,
  type SignInRef,
  type Template,
  type Wadspace,
  type Wallpaper,
  type WebApp,
} from "@core/layers";

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

/** How a layer's image stands on the machine: built from the layer as it is
 *  now (and, for a customization, on its template's image as it is now). */
export function imageState(key: LayerKey, lib: Library, images: Partial<Record<LayerKey, ImageRow>>, building: ReadonlySet<string>): ImageState {
  if (building.has(key)) return "building";
  const row = images[key];
  if (!row) return "never";
  if (key.startsWith("template:")) {
    const t = lib.templates.find((x) => x.id === key.slice(9));
    if (!t) return "built";
    return row.dockerfileSha === templateLayer(t).sha ? "built" : "changed";
  }
  const c = lib.customizations.find((x) => x.id === key.slice(7));
  const t = c && lib.templates.find((x) => x.id === c.templateId);
  if (!c || !t) return "built";
  const parent = images[`template:${t.id}`];
  return row.dockerfileSha === customizationLayer(c, t).sha && !!parent && parent.id === row.from ? "built" : "changed";
}

/** The image rows by layer. */
export const byLayer = (rows: ImageRow[]): Partial<Record<LayerKey, ImageRow>> => Object.fromEntries(rows.map((r) => [r.layer, r]));

/** What a throwaway run has instead of its wadspace's own. */
export interface RunOverrides {
  wallpaper: Wallpaper;
  projects: string[];
  secrets: Record<string, SignInRef>;
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

/** A saved sign-in a slot uses, as wadd mounts it: the app it's for (a web
 *  app's id, VS Code for an extension's, else the app), by slot. */
export function workspaceSignIns(secrets: Record<string, SignInRef>) {
  return Object.entries(secrets).map(([slot, r]) => {
    const [prefix, rest] = slot.split(/:(.*)/s);
    return {
      id: r.id,
      app: prefix === "ext" ? "vscode" : rest,
      ...(prefix === "web" && { web: true }),
      name: r.name,
      kind: r.kind,
      slot,
    };
  });
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

/** wadd's LaunchItem for what the launcher starts. */
export async function launchItem(item: RunItem, opts: { background: boolean; projectsOf: (id: string) => string[] }): Promise<Record<string, unknown>> {
  const { background } = opts;
  if (item.kind === "terminal") return { kind: "terminal", background };
  if (item.kind === "browser") {
    const c = item.config;
    const plain = DEFAULT_BROWSER_APPS[c.id];
    if (plain && !item.savedId && !c.webapps.length) return { kind: "workspace", workspace: plain, projects: [], background };
    const setup = {
      name: c.name,
      mode: c.mode,
      webapps: c.webapps,
      signins: workspaceSignIns(c.secrets).map((s) => ({ ...s, web: true })),
    };
    return { kind: "browser", setup, ...(item.savedId && { savedId: item.savedId }), background };
  }
  if (!item.overrides) return { kind: "workspace", workspace: item.wadspaceId, projects: opts.projectsOf(item.wadspaceId), background };
  const o = item.overrides;
  return {
    kind: "run",
    from: item.wadspaceId,
    overrides: { wallpaper: await wallpaperUpload(o.wallpaper), projects: o.projects, signins: workspaceSignIns(o.secrets) },
    background,
  };
}

/** PUT /v1/wadspaces/{id}: the wadspace and the layers it's on. */
export function installBody(w: Wadspace, lib: Library, tz: string) {
  const r = resolve(lib, w.base);
  if (!r) throw new Error(`${w.name}'s template or customization is gone.`);
  return { wadspace: w, template: r.template, customization: r.customization ?? null, tz };
}

/** The layer build request: a template's, or a customization's (its template with it). */
export function layerRequest(key: LayerKey, lib: Library): { layer: LayerKey; template: Template; customization: Customization | null } {
  if (key.startsWith("template:")) {
    const template = lib.templates.find((t) => t.id === key.slice(9));
    if (!template) throw new Error("That template is gone.");
    return { layer: key, template, customization: null };
  }
  const customization = lib.customizations.find((c) => c.id === key.slice(7));
  const template = customization && lib.templates.find((t) => t.id === customization.templateId);
  if (!customization || !template) throw new Error("That customization or its template is gone.");
  return { layer: key, template, customization };
}

/** The base a wadspace is on, as a layer key. */
export const layerOf = (base: BaseRef): LayerKey => imageKey(base);

/** Saved setups' fields a WadBrowser launch carries. */
export const configOf = (b: BrowserSetup): BrowserConfig => ({ id: b.id, name: b.name, mode: b.mode, webapps: b.webapps, secrets: b.secrets });

/** What the client's time zone is (a wadspace's clock). */
export const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "Etc/UTC";
