// Workspaces' common terms, as wad-core has them (crates/wad-core/src/spec.rs):
// the base image's features in install order, wadd's workspace entry (the
// quadlet's input), ids and the base image.

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

export type Display = "host" | "stream";

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
  /** Its projects (from its design): GitHub repos it clones and copies it
   *  takes in, each at ~/Desktop/<mount>. Nothing is mounted. */
  projects?: { id: string; kind: "github" | "copy"; mount: string; repo?: string; ref?: string; setup?: string }[];
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
