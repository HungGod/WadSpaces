// A Builder wadspace (model.ts) → what the generator needs (spec.ts).
//
// Desktop icons become, in order, entries of /etc/wadspaces/layout.json, and
// each app is installed the way its catalog recipe says. Apps that can't be
// installed yet are reported in `skipped` so the UI can say so.
import { recipeFor } from "./catalog/recipes";
import { dropFileIcons, orderedIcons, type LayoutIcon, type WadspaceSpec } from "./model";
import type { Project } from "./projects";
import {
  DEFAULT_IMAGE_PREFIX,
  baseImageFor,
  type AptApp,
  type CreatorSpec,
  type FeatureId,
  type KaleResource,
  type LayoutEntry,
  type WebApp,
} from "./spec";

export interface BuildOptions {
  /** Image name prefix, e.g. localhost/wadspaces- (offline builds). */
  imagePrefix?: string;
  /** Full image reference; wins over the prefix and the wadspace's own. */
  image?: string;
  /** Base image reference; defaults to the local base for the display kind. */
  baseImage?: string;
  /** The rendered wallpaper's file name in root/usr/share/backgrounds/. */
  wallpaperFile?: string;
  /** The user's projects, to name the default ones (unknown ids are left out). */
  projects?: Project[];
}

export interface BuildPlan {
  spec: CreatorSpec;
  skipped: { label: string; reason: string }[];
}

const SAFE_ID = /[^a-z0-9-]+/g;

/** The launcher KaleBrowser's packager writes for an app: WADspaces-<slug>.desktop (packager.py slugify). */
export function kaleDesktop(appName: string): string {
  const slug = appName
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `WADspaces-${slug}.desktop`;
}
const safeId = (s: string) => s.toLowerCase().replace(SAFE_ID, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "app";

/** The site a web icon opens: its own url, else the domain from its favicon URL. */
function siteOf(icon: LayoutIcon): string | undefined {
  if (icon.url) return icon.url;
  try {
    const u = new URL(icon.iconUrl, "http://local/");
    const domain = u.hostname === "www.google.com" ? u.searchParams.get("domain") : null;
    return domain ?? undefined;
  } catch {
    return undefined;
  }
}

export function toBuildSpec(ws: WadspaceSpec, opts: BuildOptions = {}): BuildPlan {
  const adv = ws.advanced;
  const features = new Set<FeatureId>(adv.tools);
  const aptApps: AptApp[] = [];
  const webapps: WebApp[] = [];
  const kaleFromIcons: KaleResource[] = [];
  const layout: LayoutEntry[] = [];
  const skipped: BuildPlan["skipped"] = [];
  const seen = new Set<string>();

  for (const icon of orderedIcons(dropFileIcons(ws.layout))) {
    const app = safeId(icon.appId);
    const autostart = icon.autostart || undefined;
    const r = recipeFor(icon.appId, siteOf(icon));
    // The same app twice on a desktop is one install and one launcher.
    if (seen.has(app)) continue;
    seen.add(app);
    switch (r.kind) {
      case "feature":
        features.add(r.feature);
        layout.push({ app, desktop: r.desktop[0], label: icon.label, autostart });
        break;
      case "builtin":
        layout.push({ app, desktop: r.desktop, label: icon.label, autostart });
        break;
      case "apt":
        aptApps.push({ id: app, packages: r.packages, ...(r.desktop && { desktop: r.desktop }) });
        layout.push({ app, ...(r.desktop && { desktop: r.desktop }), label: icon.label, autostart });
        break;
      case "webapp":
        if (icon.launcher === "kale") {
          kaleFromIcons.push({ app_name: icon.label, app_url: r.url });
          layout.push({ app, desktop: kaleDesktop(icon.label), label: icon.label, autostart });
        } else {
          webapps.push({ id: app, name: icon.label, url: r.url });
          layout.push({ app, desktop: `wadspaces-webapp-${app}.desktop`, label: icon.label, autostart });
        }
        break;
      case "soon":
        skipped.push({ label: icon.label, reason: r.reason });
        break;
    }
  }

  const kaleResources = [...adv.kaleResources, ...kaleFromIcons.filter((k) => !adv.kaleResources.some((x) => x.app_url === k.app_url))];
  const projects = (adv.projects ?? []).flatMap((id) => {
    const p = opts.projects?.find((x) => x.id === id && !x.deleted);
    return p ? [{ id, name: p.name, mount: p.mountName }] : [];
  });
  const spec: CreatorSpec = {
    id: ws.id,
    name: ws.name,
    baseImage: opts.baseImage ?? baseImageFor(adv.display),
    features: [...features],
    aptApps,
    webapps,
    kaleResources,
    ...(opts.wallpaperFile && { wallpaper: { fileName: opts.wallpaperFile, mode: "fill" as const, color: "#0b0b14" } }),
    layout,
    ...(projects.length ? { projects } : {}),
    display: adv.display,
    image: opts.image ?? adv.image ?? `${opts.imagePrefix ?? DEFAULT_IMAGE_PREFIX}${ws.id}:latest`,
    port: adv.port ?? 3160,
    hotkey: adv.hotkey ?? null,
    env: adv.env,
    secrets: adv.secrets,
    persistConfig: adv.persistConfig,
    devices: adv.devices,
    shmSize: adv.shmSize,
    autostart: adv.autostart,
  };
  return { spec, skipped };
}

/** /etc/wadspaces/layout.json: the desktop, in order. */
export function layoutJson(spec: CreatorSpec): string {
  return JSON.stringify({ version: 1, icons: spec.layout ?? [] }, null, 2) + "\n";
}
