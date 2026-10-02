// A workspace as the generator sees it: what goes into the image (build) and
// how the machine runs it (run). The run half maps 1:1 onto wadd's
// workspaces.yaml entries; the build half onto Wadspaces-David/<dir>/.
// The Builder's model (model.ts) becomes one of these through build.ts. The
// functions are wad-core's (crates/wad-core/src/spec.rs), run as WebAssembly.

import { call } from "./wasm";

export type FeatureId =
  | "git"
  | "python"
  | "cpp"
  | "nodejs"
  | "vscode"
  | "claude-code"
  | "chrome"
  | "firebase"
  | "electron-deps"
  | "kalebrowser"
  | "tiled"
  | "android-studio"
  | "hplip"
  | "obsidian";

export interface Feature {
  id: FeatureId;
  label: string;
  description: string;
  needs?: FeatureId[];
  hidden?: boolean; // pulled in automatically, not offered in the picker
}

// Order here is the order they are installed in, as wad-core's FEATURES has
// them (a test checks); keep in sync with
// Wadspaces-David/_common/root/usr/local/lib/wadspaces/features/.
export const FEATURES: Feature[] = [
  { id: "git", label: "Git", description: "git and git-lfs" },
  { id: "cpp", label: "C/C++", description: "build-essential, CMake, Ninja, gdb" },
  { id: "python", label: "Python", description: "python3, pip, venv" },
  { id: "nodejs", label: "Node.js", description: "Node 22 LTS and npm" },
  { id: "firebase", label: "Firebase CLI", description: "firebase-tools", needs: ["nodejs"] },
  { id: "electron-deps", label: "Electron libraries", description: "shared libraries for Electron apps", hidden: true },
  { id: "vscode", label: "VS Code", description: "Microsoft VS Code", needs: ["electron-deps"] },
  { id: "claude-code", label: "Claude Code", description: "Claude Code CLI with a desktop launcher", needs: ["nodejs"] },
  { id: "chrome", label: "Chrome", description: "Google Chrome; needed for web apps", needs: ["electron-deps"] },
  { id: "kalebrowser", label: "Kale Browser", description: "needed for Kale Browser apps", needs: ["nodejs", "electron-deps"], hidden: true },
  { id: "tiled", label: "Tiled", description: "tile map editor" },
  { id: "android-studio", label: "Android Studio", description: "large download; emulator needs /dev/kvm" },
  { id: "hplip", label: "HP printer tools", description: "hplip and CUPS client" },
  { id: "obsidian", label: "Obsidian", description: "Markdown notes", needs: ["electron-deps"] },
];

/** A default project (core/projects.ts): wadd mounts its folder at
 *  ~/Desktop/<mount> when the wadspace launches; nothing of it is in the image. */
export interface SpecProject {
  id: string;
  name: string;
  mount: string;
}

export interface WebApp {
  name: string;
  url: string;
  /** Catalog id: fixes the launcher name (wadspaces-webapp-<id>.desktop). */
  id?: string;
}

/** Debian packages for one desktop app (wadspaces-apt). */
export interface AptApp {
  id: string;
  packages: string[];
  desktop?: string;
}

/** One desktop icon, in order, for /etc/wadspaces/layout.json. */
export interface LayoutEntry {
  /** Catalog id; wadspaces-layout finds its launcher in /etc/wadspaces/apps.d/<app>.list
   *  when `desktop` is absent or missing from the image. */
  app: string;
  /** The launcher to put on the desktop, e.g. code.desktop. */
  desktop?: string;
  label: string;
  autostart?: boolean;
}

export interface KaleResource {
  app_name: string;
  app_url: string;
}

export interface Wallpaper {
  fileName: string; // wallpaper.png | wallpaper.jpg
  dataUrl?: string; // local-only mode
  mode: "center" | "fill" | "fit" | "stretch" | "tile";
  color: string;
}

// How a workspace is shown on the machine (wadd's `display`):
//   host    a lean image (containers/_common) whose desktop is a window on
//           the machine's own screen: local input, no stream. The same image
//           runs remotely next to the stream sidecar (containers/_stream).
//   stream  an all-in-one Selkies image (containers/_selkies) streamed into
//           the kiosk.
export type Display = "host" | "stream";

export interface CreatorSpec {
  id: string;
  name: string;
  // build
  baseImage: string;
  features: FeatureId[];
  aptApps?: AptApp[];
  webapps: WebApp[];
  kaleResources: KaleResource[];
  wallpaper?: Wallpaper;
  /** Desktop icons in order; absent for hand-written specs (the presets). */
  layout?: LayoutEntry[];
  /** Projects it opens with by default; mounted at launch, listed in the README. */
  projects?: SpecProject[];
  // run
  display?: Display; // absent on specs saved before it existed: "stream"
  image: string;
  port: number; // stream only
  hotkey?: number | null;
  env: Record<string, string>;
  secrets: string[];
  persistConfig: boolean;
  devices: string[];
  shmSize: string;
  autostart: boolean;
  updatedAt?: number;
}

// What wadd stores in workspaces.yaml (see legacy/wadd-py/wadd/config.py).
export interface WaddSpec {
  id: string;
  name: string;
  image: string;
  port?: number;
  display?: Display;
  hotkey?: number | null;
  icon?: string | null;
  enabled?: boolean;
  container_name?: string;
  container_port?: number;
  env?: Record<string, string>;
  secrets?: string[];
  volumes?: string[];
  devices?: string[];
  shm_size?: string | null;
  autostart?: boolean;
  /** Set by wadd when it launches with projects (wadd/launches.py), never by the app.
   *  `path`: a folder or drive project, mounted where it is. */
  projects?: { id: string; mount: string; path?: string }[];
}

export const DEFAULT_BASE_IMAGE = "localhost/wadspaces-base:trixie";
export const SELKIES_BASE_IMAGE = "localhost/wadspaces-selkies:trixie";
export const baseImageFor = (d: Display): string => call("baseImageFor", d);
export const DEFAULT_IMAGE_PREFIX = "localhost/wadspaces-";
export const ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function newSpec(partial: Partial<CreatorSpec> = {}): CreatorSpec {
  return call("newSpec", partial);
}

export function slugify(s: string): string {
  return call("slugify", s);
}

/** Features in install order. Web apps imply chrome and Kale Browser apps imply
 *  kalebrowser; other dependencies are installed by the feature scripts
 *  themselves (`need nodejs`), so they are not listed. */
export function resolveFeatures(spec: Pick<CreatorSpec, "features" | "webapps" | "kaleResources">): FeatureId[] {
  return call("resolveFeatures", spec);
}

export function volumesFor(spec: Pick<CreatorSpec, "id" | "persistConfig">): string[] {
  return call("volumesFor", spec);
}

export function toWaddSpec(spec: CreatorSpec): WaddSpec {
  return call("toWaddSpec", spec);
}

/** Merge a machine's runtime spec into a creator spec (for editing). */
export function fromWaddSpec(w: WaddSpec, base?: CreatorSpec): CreatorSpec {
  return call("fromWaddSpec", w, ...(base ? [base] : []));
}

export function validate(spec: CreatorSpec): string[] {
  return call("validate", spec);
}
