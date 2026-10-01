// A wadspace as the Builder edits it and as it is stored: offline in wadd's
// library on the machine, online in Firestore. Shared by the app and the
// Cloud Functions, so: no React, no DOM, no import.meta.env.
import type { Display, FeatureId, KaleResource } from "./spec";

export type Visibility = "private" | "shared";

export interface Wallpaper {
  type: "gradient" | "image" | "color";
  value: string;
}

export interface LayoutIcon {
  id: string;
  /** App catalog id. */
  appId: string;
  label: string;
  iconUrl: string;
  color: string;
  /** Free position as a fraction of the desktop (0..1), used when grid snapping is off. */
  x: number;
  y: number;
  /** Grid cell, used when grid snapping is on. Rows that don't fit wrap into the next column. */
  cell?: { col: number; row: number };
  /** Open this app's window as soon as the wadspace boots. */
  autostart?: boolean;
  /** Web apps only: open in Chrome (default) or as a Kale Browser app. */
  launcher?: "chrome" | "kale";
  /** Custom (non-catalog) web apps: the site to open. */
  url?: string;
}

export interface Layout {
  wallpaper: Wallpaper;
  icons: LayoutIcon[];
  grid: boolean;
}

export type AgentRuntime = "claude-code" | "codex" | "gemini-cli" | "deepseek" | "opencode" | "qwen-code" | "aider" | "lm-studio" | "custom";

export interface AgentConfig {
  enabled: boolean;
  runtime: AgentRuntime;
  model: string;
  /** Launch command, for the "custom" runtime. */
  command?: string;
  /** The prompt the agent starts working on as soon as the container is up. */
  prompt: string;
  /** Instructions the agent keeps for the whole session (like a CLAUDE.md). */
  instructions: string;
  autonomy: "ask" | "auto";
  permissions: { internet: boolean; terminal: boolean; writeFiles: boolean; installPackages: boolean };
}

/**
 * Everything beyond the desktop: how the image is built and how a machine
 * runs it. These are the old Editor's fields; the Builder shows them under
 * "Advanced".
 */
export interface Advanced {
  /** host: lean image, a window on the machine's screen (streams through the
   *  sidecar when remote). stream: legacy all-in-one Selkies image. */
  display: Display;
  /** Streamed display port on the machine; assigned by wadd when absent. */
  port?: number | null;
  /** Super+N on the kiosk. */
  hotkey?: number | null;
  /** Tools without a desktop icon (git, python, nodejs, ...). */
  tools: FeatureId[];
  /** Ids of the projects (core/projects.ts) it opens with unless you pick
   *  others: folders on the machine mounted at ~/Desktop/<mountName>. */
  projects: string[];
  kaleResources: KaleResource[];
  env: Record<string, string>;
  /** Podman secrets on the machine, e.g. github_token. */
  secrets: string[];
  devices: string[];
  shmSize: string;
  /** Keep /config (settings, sign-ins, Desktop) between runs. */
  persistConfig: boolean;
  /** Start with the machine instead of on first use. */
  autostart: boolean;
  /** Override the image name. */
  image?: string;
}

/** The part of a wadspace that defines the image: what the Builder saves. */
export interface WadspaceSpec {
  id: string;
  name: string;
  description: string;
  layout: Layout;
  advanced: Advanced;
  agent?: AgentConfig;
  /** A hand-edited Dockerfile (offline builds only). Absent means generated. */
  dockerfile?: string;
}

export function defaultAdvanced(tz = "Etc/UTC"): Advanced {
  return {
    display: "host",
    port: null,
    hotkey: null,
    tools: ["git"],
    projects: [],
    kaleResources: [],
    env: { PUID: "1000", PGID: "1000", TZ: tz },
    secrets: [],
    devices: ["/dev/dri"],
    shmSize: "1g",
    persistConfig: true,
    autostart: false,
  };
}

/** Lowercase `slug-xxxxxx`: valid as a wadd id, a container name and an image path. */
export function newWadspaceId(name: string, rand: () => number = Math.random): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "wadspace";
  const tail = Array.from({ length: 6 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(rand() * 36)]).join("");
  return `${slug}-${tail}`;
}

/** Desktops saved with cloud-file shortcuts (`kind: "file"`, removed with
 *  cloud files) lose them when they're loaded. */
export function dropFileIcons(layout: Layout): Layout {
  const icons = layout.icons.filter((i) => (i as { kind?: string }).kind !== "file");
  return icons.length === layout.icons.length ? layout : { ...layout, icons };
}

/** Icons in desktop order: by grid cell (column-major), else top-to-bottom, left-to-right. */
export function orderedIcons(layout: Layout): LayoutIcon[] {
  const key = (i: LayoutIcon) => (layout.grid && i.cell ? [i.cell.col, i.cell.row] : [Math.round(i.x * 20), i.y]);
  return [...layout.icons].sort((a, b) => {
    const [a0, a1] = key(a);
    const [b0, b1] = key(b);
    return a0 - b0 || a1 - b1;
  });
}
