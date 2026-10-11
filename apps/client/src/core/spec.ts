// A workspace as the generator sees it: what goes into the image (build) and
// how the machine runs it (run). The run half maps 1:1 onto wadd's
// workspace entries; the build half onto a build folder (generator/).
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
  | "tiled"
  | "android-studio"
  | "hplip"
  | "obsidian"
  | "gcloud"
  | "rust"
  | "go"
  | "java"
  | "libresprite"
  | "audacity"
  | "krita"
  | "openshot"
  | "steam"
  | "dolphin";

export interface Feature {
  id: FeatureId;
  label: string;
  description: string;
  needs?: FeatureId[];
  hidden?: boolean; // pulled in automatically, not offered in the picker
}

// Order here is the order they are installed in, as wad-core's FEATURES has
// them (a test checks); keep in sync with
// images/base/root/usr/local/lib/wadspaces/features/ (the monorepo's).
export const FEATURES: Feature[] = [
  { id: "git", label: "Git", description: "git and git-lfs" },
  { id: "cpp", label: "C/C++", description: "build-essential, CMake, Ninja, gdb" },
  { id: "python", label: "Python", description: "python3, pip, venv" },
  { id: "nodejs", label: "Node.js", description: "Node 22 LTS and npm" },
  { id: "firebase", label: "Firebase CLI", description: "firebase-tools", needs: ["nodejs"] },
  { id: "gcloud", label: "Google Cloud CLI", description: "gcloud, gsutil and bq from Google's apt repo" },
  { id: "rust", label: "Rust", description: "rustup, cargo and the stable toolchain" },
  { id: "go", label: "Go", description: "Debian's golang" },
  { id: "java", label: "Java", description: "OpenJDK (Debian's default-jdk)" },
  { id: "electron-deps", label: "Electron libraries", description: "shared libraries for Electron apps", hidden: true },
  { id: "vscode", label: "VS Code", description: "Microsoft VS Code", needs: ["electron-deps"] },
  { id: "claude-code", label: "Claude Code", description: "Claude Code CLI with a desktop launcher", needs: ["nodejs"] },
  { id: "chrome", label: "Chrome", description: "Google Chrome; web apps that need it (DRM, video calls) bring it", needs: ["electron-deps"] },
  { id: "tiled", label: "Tiled", description: "tile map editor" },
  { id: "android-studio", label: "Android Studio", description: "large download; emulator needs /dev/kvm" },
  { id: "hplip", label: "HP printer tools", description: "hplip and CUPS client" },
  { id: "obsidian", label: "Obsidian", description: "Markdown notes", needs: ["electron-deps"] },
  { id: "libresprite", label: "LibreSprite", description: "pixel art and sprite animation" },
  { id: "audacity", label: "Audacity", description: "record and edit audio" },
  { id: "krita", label: "Krita", description: "digital painting" },
  { id: "openshot", label: "OpenShot", description: "video editor" },
  { id: "steam", label: "Steam", description: "Valve's game launcher; needs /dev/dri" },
  { id: "dolphin", label: "Dolphin", description: "GameCube and Wii emulator" },
];

/** A default project (core/projects.ts): wadd mounts its folder at
 *  ~/Desktop/<mount> when the wadspace launches; nothing of it is in the image. */
export interface SpecProject {
  id: string;
  name: string;
  mount: string;
}

/** A website in a WadBrowser window of its own (wadspaces-webapp). */
export interface WebApp {
  name: string;
  url: string;
  /** Catalog id: fixes the launcher name (wadspaces-webapp-<id>.desktop). */
  id?: string;
  /** A site WadBrowser can't run (DRM, video calls): a Chrome --app window. */
  chrome?: boolean;
  /** The user's own picture for its icon (an upload's data: URL, or an
   *  address); otherwise wadd makes one from the site's icon. */
  iconUrl?: string;
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

/** A Kale Browser app, from designs made before WadBrowser: built as a web app now. */
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
//   host    a lean image (images/base) whose desktop is a window on the
//           machine's own screen: local input, no stream.
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
  /** What links open in: the WadBrowser on its desktop ("full": with an
   *  address bar; "focus": without). Absent: the base's default (focus). */
  defaultBrowser?: "full" | "focus";
  wallpaper?: Wallpaper;
  /** Desktop icons in order; absent for hand-written specs (the presets). */
  layout?: LayoutEntry[];
  /** Projects it opens with by default; mounted at launch, listed in the README. */
  projects?: SpecProject[];
  /** The saved sign-ins its apps use; mounted when it starts (no rebuild). */
  signins?: WaddSignIn[];
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

// What wadd stores for a workspace (wad-proto's Workspace, workspaces.yaml's shape).
export interface WaddSpec {
  id: string;
  name: string;
  /** "app": a program on the machine itself (Terminal, WadBrowser), from the
   *  image only; it has `exec` instead of an image (`image` is empty). */
  kind?: "app";
  exec?: string[];
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
  /** The saved sign-ins its apps use (from its design): `app` is the app's
   *  id, `web` a web app's (a WadBrowser profile). */
  signins?: WaddSignIn[];
}

export interface WaddSignIn {
  id: string;
  app: string;
  web?: boolean;
  name?: string;
}

export const DEFAULT_BASE_IMAGE = "localhost/wadspaces-base:trixie";
export const ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function newSpec(partial: Partial<CreatorSpec> = {}): CreatorSpec {
  return call("newSpec", partial);
}
