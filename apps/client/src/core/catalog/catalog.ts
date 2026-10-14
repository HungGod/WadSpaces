// The Builder's catalog (crates/wad-core/data/catalog.json, shared with the
// Rust core): the apps a template is made of, VS Code's extensions and the
// command-line tools a customization adds. Each app says what it is (summary,
// screenshots, its Start menu category) and how it gets into an image. The
// starter templates every library begins with are in starters.json.
import data from "@core-data/catalog.json";
import startersData from "@core-data/starters.json";
import type { SecretKind } from "../layers";

export interface Shot {
  src: string;
  caption: string;
}

/** How an app gets into a template's image. */
export type Install =
  | { kind: "feature"; feature: string; desktop: string[]; source: string }
  | { kind: "apt"; id: string; packages: string[]; desktop: string[]; source: string }
  | { kind: "builtin"; desktop: string[]; source: string };

export interface AppDef {
  id: string;
  name: string;
  summary: string;
  description: string;
  /** selkies-desktop's Start menu category. */
  category: string;
  icon: string;
  screenshots: Shot[];
  install: Install;
  /** The linuxserver.io image it follows, if one. */
  example: string | null;
  /** Its licence, as its publisher gives it. */
  license: string | null;
  homepage: string | null;
  /** What a customization can set for it (Step 2). */
  options: "wadbrowser" | "vscode" | null;
  /** Opens a folder in a window: without one, projects get no desktop icon. */
  opensFolders: boolean;
  /** The sign-in it can keep (Step 3); `id` names a new secret: <wadspace>-<id>. */
  secret: { kind: SecretKind; id: string } | null;
}

export interface ExtensionDef {
  /** Marketplace id. */
  id: string;
  name: string;
  description: string;
  secret: { kind: SecretKind; id: string } | null;
}

export interface ToolDef {
  id: string;
  name: string;
  description: string;
}

export interface StarterDef {
  id: string;
  name: string;
  description: string;
  apps: string[];
}

export const APPS = data.apps as AppDef[];
export const EXTENSIONS = data.extensions as ExtensionDef[];
export const TOOLS = data.tools as ToolDef[];
export const STARTERS = startersData as StarterDef[];

export const appById = (id: string): AppDef | undefined => APPS.find((a) => a.id === id);

/** An extension's icon, for the ones that bring their own (else VS Code's stands in). */
const EXTENSION_ICONS: Record<string, string> = { "anthropic.claude-code": "/icons/claude.png", "openai.chatgpt": "/icons/codex.png" };
export const extensionIcon = (id: string): string | undefined => EXTENSION_ICONS[id];

/** An extension: the catalog's, or one added by its marketplace id. */
export const extensionById = (id: string): ExtensionDef =>
  EXTENSIONS.find((e) => e.id === id) ?? { id, name: id, description: "From the marketplace", secret: null };

export const toolById = (id: string): ToolDef | undefined => TOOLS.find((t) => t.id === id);

/** The RUN line an app's install adds to its template's Dockerfile. */
export function runLine(app: AppDef): string | null {
  const i = app.install;
  if (i.kind === "feature") return `wadspaces-feature ${i.feature}`;
  if (i.kind === "apt") return `wadspaces-apt ${i.id}${i.desktop[0] ? ` --desktop ${i.desktop[0]}` : ""} ${i.packages.join(" ")}`;
  return null;
}

/** What a sign-in of each kind keeps, for the Secrets page and Step 3. */
export const SECRET_KINDS: Record<SecretKind, { label: string; keeps: string }> = {
  web: { label: "WadBrowser sign-in", keeps: "A cookie profile: one or more web apps can share it" },
  vscode: { label: "VS Code settings", keeps: "VS Code's accounts, settings, keybindings and snippets" },
  obsidian: { label: "Obsidian sign-in", keeps: "Obsidian's account (Sync, Publish)" },
  steam: { label: "Steam sign-in", keeps: "Steam's login and each account's settings" },
  "vscode-claude-code": { label: "Claude Code sign-in", keeps: "Claude Code's login and settings (~/.claude)" },
  "vscode-codex": { label: "Codex sign-in", keeps: "Codex's login and settings (~/.codex)" },
};
