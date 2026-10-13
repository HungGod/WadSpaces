// What the board knows of the catalog (crates/wad-core/data/catalog.json,
// through core/catalog), and what it works out from it: customization
// layers, keys and their WadBrowser groups, misconfiguration and its fixes,
// what a desktop shows.
import { APPS as CATALOG_APPS, EXTENSIONS as CATALOG_EXTENSIONS, TOOLS as CATALOG_TOOLS, SECRET_KINDS } from "@core/catalog/catalog";
import { WALLPAPER_PRESETS } from "@/components/desktop/wallpapers";
import type { AppSubKey, KeyGroup, Layer, SecretKind, SecretRef, SecretsSub, Stack, WebApp } from "./model";
import { appsOf, subOf } from "./model";
import { siteIcon } from "@/lib/webIcon";

export interface CatalogApp {
  id: string;
  name: string;
  category: string;
  icon: string;
  summary: string;
  /** The customization layer it has, if any. */
  layer?: AppSubKey;
  /** The sign-in it can keep (a secret slot). */
  secret?: SecretKind;
}

export const APPS: CatalogApp[] = CATALOG_APPS.map((a) => ({
  id: a.id,
  name: a.name,
  category: a.category,
  icon: a.icon,
  summary: a.summary,
  ...(a.options && { layer: a.options }),
  ...(a.secret && { secret: a.secret.kind }),
}));

export const app = (id: string) => APPS.find((a) => a.id === id);

/** Command-line tools aren't an app on the desktop, but they're a layer every template has. */
export const TERMINAL = { id: "terminal", name: "Command line", icon: "/icons/terminal.png", summary: "Tools on the PATH: compilers, CLIs" };

export const APP_SUB_INFO: Record<AppSubKey, { title: string; app: string; icon: string }> = {
  vscode: { title: "VS Code extensions", app: "VS Code", icon: "/apps/vscode/icon.png" },
  wadbrowser: { title: "WadBrowser apps", app: "WadBrowser", icon: "/brand/wadbrowser-icon-dark.svg" },
  tools: { title: "Command-line tools", app: "Command line", icon: "/icons/terminal.png" },
};

export interface Extension {
  id: string;
  name: string;
  icon?: string;
  secret?: SecretKind;
}

const EXTENSION_ICONS: Record<string, string> = { "anthropic.claude-code": "/icons/claude.png", "openai.chatgpt": "/icons/codex.png" };

export const EXTENSIONS: Extension[] = CATALOG_EXTENSIONS.map((e) => ({
  id: e.id,
  name: e.name,
  ...(EXTENSION_ICONS[e.id] && { icon: EXTENSION_ICONS[e.id] }),
  ...(e.secret && { secret: e.secret.kind }),
}));

export const extension = (id: string): Extension => EXTENSIONS.find((e) => e.id === id) ?? { id, name: id };

export const TOOLS = CATALOG_TOOLS.map((t) => ({ id: t.id, name: t.name }));

export const tool = (id: string) => TOOLS.find((t) => t.id === id) ?? { id, name: id };

/** The backgrounds to pick from: shaded gradients in the WadSpaces colours (a picture can be chosen too). */
export const WALLPAPERS = WALLPAPER_PRESETS.map((p) => ({ ...p.wallpaper, name: p.name }));

export const wallpaperCss = (w: { type: string; value: string } | undefined) =>
  !w ? "linear-gradient(135deg,#140d22,#241a39)" : w.type === "image" ? `center / cover no-repeat url("${w.value}")` : w.value;

/** A web app's icon (lib/webIcon.ts): the site's own, fetched once and kept. */
export const webappIcon = (w: WebApp) => siteIcon(w.url);

export const webappId = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "app";

export const SECRET_KIND_LABEL: Record<SecretKind, string> = Object.fromEntries(Object.entries(SECRET_KINDS).map(([k, v]) => [k, v.label])) as Record<SecretKind, string>;

export interface SecretSlot {
  key: string;
  kind: SecretKind;
  label: string;
  /** Names a new secret: <Wadspace>-<appId>. */
  appId: string;
  icon: string;
}

/** The sign-ins a stack can keep, in desktop order: apps, extensions, then web apps. */
// ─────────────────────────────── keys ───────────────────────────────

/** One of WadBrowser's apps, for its key groups: the browser itself, or a web app. */
export interface BrowserItem {
  id: string;
  name: string;
  icon: string;
}

/** WadBrowser and its web apps, when the template has WadBrowser. */
export function browserItems(s: Stack): BrowserItem[] {
  if (!appsOf(s).includes("wadbrowser")) return [];
  return [
    { id: "browser", name: "WadBrowser", icon: "/brand/wadbrowser-icon-dark.svg" },
    ...(subOf(s.extensions, "wadbrowser")?.webapps ?? []).map((w) => ({ id: `web:${w.id}`, name: w.name, icon: webappIcon(w) })),
  ];
}

/**
 * WadBrowser's key groups, tidied: members that are gone dropped, and anything
 * not in a group yet joining the first group that has apps (by default one
 * group: everything shares one profile). An empty group made with New group
 * stays, waiting for apps to be dragged in.
 */
export function keyGroupsOf(s: Stack, sub?: SecretsSub): KeyGroup[] {
  const items = browserItems(s).map((i) => i.id);
  if (!items.length) return [];
  const groups = (sub?.groups ?? []).map((g) => ({ ...g, members: g.members.filter((m) => items.includes(m)) }));
  const placed = new Set(groups.flatMap((g) => g.members));
  const loose = items.filter((i) => !placed.has(i));
  if (!loose.length) return groups;
  const first = groups.findIndex((g) => g.members.length);
  if (first < 0) return [{ id: "all", members: loose }, ...groups];
  groups[first] = { ...groups[first], members: [...groups[first].members, ...loose] };
  return groups;
}

/** One key a stack could have: what signs in with it, and where it's kept. */
export interface KeyLine {
  /** "app:vscode", "ext:<id>", "app:obsidian", "app:steam", or "group:<id>" for a WadBrowser group. */
  slot: string;
  kind: SecretKind;
  label: string;
  icon: string;
  /** Names a new key: <Wadspace>-<this>. */
  appId: string;
  /** A WadBrowser group: who shares it. */
  group?: KeyGroup;
  members?: BrowserItem[];
}

/** An app with keys, and its key lines. */
export interface KeyApp {
  id: string;
  name: string;
  icon: string;
  lines: KeyLine[];
}

/** The keys a stack could have, by app, in desktop order: WadBrowser's groups, VS Code's settings and extensions, Obsidian, Steam. */
export function keyMap(s: Stack, sub = subOf(s.customization, "secrets")): KeyApp[] {
  const out: KeyApp[] = [];
  for (const id of appsOf(s)) {
    const a = app(id);
    if (!a) continue;
    if (id === "wadbrowser") {
      const items = browserItems(s);
      const lines = keyGroupsOf(s, sub).map((g) => {
        const members = g.members.map((m) => items.find((i) => i.id === m)!).filter(Boolean);
        const only = members.length === 1 ? members[0] : undefined;
        return { slot: `group:${g.id}`, kind: "web" as const, label: only ? only.name : members.length ? `${members.length} apps` : "Empty group", icon: only?.icon ?? a.icon, appId: only && only.id !== "browser" ? `WadBrowser-${only.name.replace(/\s/g, "")}` : "WadBrowser", group: g, members };
      });
      out.push({ id, name: a.name, icon: a.icon, lines });
    } else if (id === "vscode") {
      const lines: KeyLine[] = [{ slot: "app:vscode", kind: "vscode", label: "Settings", icon: a.icon, appId: "VSCode" }];
      for (const x of subOf(s.extensions, "vscode")?.extensions ?? []) {
        const e = extension(x);
        if (e.secret) lines.push({ slot: `ext:${x}`, kind: e.secret, label: e.name, icon: e.icon ?? a.icon, appId: `VSCode-${e.name.replace(/\s/g, "")}` });
      }
      out.push({ id, name: a.name, icon: a.icon, lines });
    } else if (a.secret) {
      out.push({ id, name: a.name, icon: a.icon, lines: [{ slot: `app:${id}`, kind: a.secret, label: id === "steam" ? "Account" : "Vault sync", icon: a.icon, appId: a.name.replace(/\s/g, "") }] });
    }
  }
  return out;
}

/** The key a line has, if any. */
export const keyOf = (sub: SecretsSub | undefined, line: KeyLine): SecretRef | undefined => (line.group ? line.group.key : sub?.bySlot[line.slot]);

/** How many keys a stack could have, and how many it has. */
export function keyCount(s: Stack): { all: number; set: number } {
  const sub = subOf(s.customization, "secrets");
  // An empty WadBrowser group signs nothing in: it doesn't count.
  const lines = keyMap(s, sub)
    .flatMap((a) => a.lines)
    .filter((l) => !l.group || l.group.members.length);
  return { all: lines.length, set: lines.filter((l) => keyOf(sub, l)).length };
}

/** The key a web app (or the browser) signs in with: its group's. */
export function webKey(s: Stack, member: string): SecretRef | undefined {
  return keyGroupsOf(s, subOf(s.customization, "secrets")).find((g) => g.members.includes(member))?.key;
}

// ─────────────────────────────── misconfiguration ───────────────────────────────

export type Fix = { kind: "addApp"; appId: string; label: string } | { kind: "removeApp"; appId: string; label: string } | { kind: "removeKey"; slot: string; label: string };

export interface Problem {
  id: string;
  text: string;
  fixes: Fix[];
}

/**
 * What doesn't add up in a stack: app setups or keys for an app its template
 * doesn't have, and keys for extensions that aren't there any more. Each comes
 * with fixes: add the app, or take out what needs it.
 */
export function problemsOf(s: Stack): Problem[] {
  const apps = appsOf(s);
  if (!apps.length) return [];
  const sub = subOf(s.customization, "secrets");
  const keys = sub?.bySlot ?? {};
  const out: Problem[] = [];
  const parts = (appId: string): string[] => {
    const p: string[] = [];
    if (appId === "vscode" && subOf(s.extensions, "vscode")) p.push("its extensions are set up");
    if (appId === "wadbrowser" && subOf(s.extensions, "wadbrowser")) p.push("its web apps are set up");
    const hasKeys =
      appId === "vscode" ? Object.keys(keys).some((k) => k === "app:vscode" || k.startsWith("ext:")) : appId === "wadbrowser" ? !!sub?.groups?.some((g) => g.key) : !!keys[`app:${appId}`];
    if (hasKeys) p.push("keys are kept for it");
    return p;
  };
  for (const appId of ["wadbrowser", "vscode", "obsidian", "steam"]) {
    if (apps.includes(appId)) continue;
    const p = parts(appId);
    if (!p.length) continue;
    const name = app(appId)!.name;
    out.push({
      id: `missing:${appId}`,
      text: `${name} isn't in the template, but ${p.join(" and ")}.`,
      fixes: [
        { kind: "addApp", appId, label: `Add ${name} to the template` },
        { kind: "removeApp", appId, label: `Remove ${name}'s ${p.length === 2 ? "setup and keys" : p[0].startsWith("keys") ? "keys" : "setup"}` },
      ],
    });
  }
  if (apps.includes("vscode")) {
    const installed = subOf(s.extensions, "vscode")?.extensions ?? [];
    for (const k of Object.keys(keys).filter((k) => k.startsWith("ext:") && !installed.includes(k.slice(4)))) {
      const e = extension(k.slice(4));
      out.push({ id: `stray:${k}`, text: `A key is kept for ${e.name}, but it isn't one of VS Code's extensions.`, fixes: [{ kind: "removeKey", slot: k, label: `Remove the ${e.name} key` }] });
    }
  }
  return out;
}

export function secretSlots(s: Stack): SecretSlot[] {
  const out: SecretSlot[] = [];
  for (const id of appsOf(s)) {
    const a = app(id);
    if (a?.secret) out.push({ key: `app:${id}`, kind: a.secret, label: a.name, appId: a.name.replace(/\s/g, ""), icon: a.icon });
  }
  if (appsOf(s).includes("vscode")) {
    for (const id of subOf(s.extensions, "vscode")?.extensions ?? []) {
      const e = extension(id);
      if (e.secret) out.push({ key: `ext:${id}`, kind: e.secret, label: `${e.name} (VS Code)`, appId: `VSCode-${e.name.replace(/\s/g, "")}`, icon: e.icon ?? "/apps/vscode/icon.png" });
    }
  }
  if (appsOf(s).includes("wadbrowser")) {
    for (const w of subOf(s.extensions, "wadbrowser")?.webapps ?? []) {
      out.push({ key: `web:${w.id}`, kind: "web", label: `${w.name} (web app)`, appId: `WadBrowser-${w.name.replace(/\s/g, "")}`, icon: webappIcon(w) });
    }
  }
  return out;
}

export interface DesktopIcon {
  id: string;
  label: string;
  icon: string;
  from: Layer;
}

/** What the wadspace's desktop shows: template apps, then web apps, then mounted folders. */
export function desktopOf(s: Stack): DesktopIcon[] {
  const out: DesktopIcon[] = [];
  for (const id of appsOf(s)) {
    const a = app(id);
    if (a) out.push({ id: `app:${id}`, label: a.name, icon: a.icon, from: "template" });
  }
  if (appsOf(s).includes("wadbrowser"))
    for (const w of subOf(s.extensions, "wadbrowser")?.webapps ?? []) out.push({ id: `web:${w.id}`, label: w.name, icon: webappIcon(w), from: "extensions" });
  if (appsOf(s).includes("vscode"))
    for (const m of subOf(s.customization, "folders")?.mounts ?? []) out.push({ id: `dir:${m.id}`, label: m.as, icon: "/folder.svg", from: "customization" });
  return out;
}

/** The app setups a stack could have: WadBrowser's and VS Code's when its template has them, and the command line's always. */
export function setupsFor(apps: string[]): AppSubKey[] {
  return [...(apps.includes("wadbrowser") ? (["wadbrowser"] as const) : []), ...(apps.includes("vscode") ? (["vscode"] as const) : []), "tools"];
}

/** Whether a submodule's app is in the template (else it does nothing there). */
export function subFits(key: AppSubKey, apps: string[] | undefined): { ok: boolean; why?: string } {
  if (!apps) return { ok: true };
  if (key === "vscode" && !apps.includes("vscode")) return { ok: false, why: "VS Code isn't in this template" };
  if (key === "wadbrowser" && !apps.includes("wadbrowser")) return { ok: false, why: "WadBrowser isn't in this template" };
  return { ok: true };
}
