import { defaultAgent } from "./agent";
import { favicon } from "./favicon";
import type { AgentConfig, App, Layout, LayoutIcon } from "./types";

/** Pre-made wadspaces anyone can launch, download, and throw away again. */
export type TemplateCategory = "ai" | "dev" | "creative" | "focus" | "games" | "everyday";

export interface Template {
  id: string;
  name: string;
  description: string;
  category: TemplateCategory;
  /** App catalog ids, top to bottom on the desktop. The first one is the wadspace's hero app. */
  apps: string[];
  /** Apps whose windows open as soon as the wadspace boots. */
  startup?: string[];
  /** Cover photo for the card, also used as the desktop wallpaper. */
  image: string;
  sizeMB: number;
  /** Small enough to ship pre-cached with the WAD SPACES client, so it opens without a download. */
  instant?: boolean;
  agent?: AgentConfig;
}

export const CATEGORIES: { value: TemplateCategory; label: string; blurb: string }[] = [
  { value: "ai", label: "AI agents", blurb: "Pick a coding harness, attach your files, let it rip." },
  { value: "dev", label: "Development", blurb: "Editors, terminals and toolchains, preinstalled." },
  { value: "creative", label: "Creative", blurb: "Design, 3D, photo, video and audio suites." },
  { value: "focus", label: "Focus & study", blurb: "Distraction-free desks for deep work." },
  { value: "games", label: "Games", blurb: "Emulators and launchers in a box." },
  { value: "everyday", label: "Everyday", blurb: "Throwaway browsers, chat and meeting rooms." },
];

const agent = (patch: Partial<AgentConfig>): AgentConfig => ({ ...defaultAgent(), ...patch, permissions: { ...defaultAgent().permissions, ...patch.permissions } });
const img = (slug: string) => `/quicklaunch/${slug}.jpg`;
const CODING = "Read the files I attached, plan the work, then get going.";

export const TEMPLATES: Template[] = [
  // AI: the coding harnesses first, one wadspace each.
  {
    id: "ai-claude-code", category: "ai", name: "Claude Code", sizeMB: 2140, image: img("claude-code"),
    description: "Anthropic's coding agent with VS Code, a terminal and GitHub.",
    apps: ["claude-code", "vscode", "terminal", "github", "chromium"], startup: ["claude-code", "vscode"],
    agent: agent({ prompt: CODING, instructions: "Commit in small steps and explain each change." }),
  },
  {
    id: "ai-codex", category: "ai", name: "Codex", sizeMB: 2080, image: img("codex"),
    description: "OpenAI's Codex CLI with VS Code, a terminal and GitHub.",
    apps: ["codex", "vscode", "terminal", "github", "chromium"], startup: ["codex", "vscode"],
    agent: agent({ runtime: "codex", model: "gpt-5-codex", prompt: CODING }),
  },
  {
    id: "ai-deepseek", category: "ai", name: "DeepSeek", sizeMB: 1990, image: img("deepseek"),
    description: "DeepSeek's coder models in a terminal harness, with VSCodium.",
    apps: ["deepseek", "vscodium", "terminal", "github"], startup: ["deepseek", "vscodium"],
    agent: agent({ runtime: "deepseek", model: "deepseek-v4", prompt: CODING }),
  },
  {
    id: "ai-gemini", category: "ai", name: "Gemini CLI", sizeMB: 2010, image: img("gemini"),
    description: "Google's Gemini CLI with VS Code, a terminal and Chrome.",
    apps: ["gemini-cli", "vscode", "terminal", "github", "chrome"], startup: ["gemini-cli", "vscode"],
    agent: agent({ runtime: "gemini-cli", model: "gemini-3-pro", prompt: CODING }),
  },
  {
    id: "ai-opencode", category: "ai", name: "OpenCode", sizeMB: 1870, image: img("opencode"),
    description: "The open-source terminal agent. Bring any model.",
    apps: ["opencode", "code-server", "terminal", "github"], startup: ["opencode", "code-server"],
    agent: agent({ runtime: "opencode", model: "claude-sonnet-5", prompt: CODING }),
  },
  {
    id: "ai-qwen", category: "ai", name: "Qwen Code", sizeMB: 1920, image: img("qwen"),
    description: "Alibaba's Qwen3-Coder agent with VSCodium and a terminal.",
    apps: ["qwen-code", "vscodium", "terminal", "github"], startup: ["qwen-code", "vscodium"],
    agent: agent({ runtime: "qwen-code", model: "qwen3-coder-plus", prompt: CODING }),
  },
  {
    id: "ai-aider", category: "ai", name: "Aider", sizeMB: 1640, image: img("aider"),
    description: "AI pair programming in your terminal, committing as it goes.",
    apps: ["aider", "terminal", "vscode", "github"], startup: ["aider"],
    agent: agent({ runtime: "aider", model: "claude-sonnet-5", prompt: CODING }),
  },
  {
    id: "ai-offline", category: "ai", name: "Offline Local Agent", sizeMB: 5480, image: img("lm-studio"),
    description: "LM Studio with a local model and no internet. Nothing leaves the container.",
    apps: ["lm-studio", "opencode", "vscodium", "terminal"], startup: ["lm-studio", "opencode"],
    agent: agent({ runtime: "lm-studio", model: "qwen3-coder-30b (local)", prompt: CODING, permissions: { internet: false, terminal: true, writeFiles: true, installPackages: false } }),
  },
  {
    id: "ai-research", category: "ai", name: "Research Agent", sizeMB: 1380, image: img("research"),
    description: "Browses, reads your papers in Zotero and writes a sourced report in Obsidian.",
    apps: ["claude", "chromium", "zotero", "obsidian"], startup: ["chromium", "obsidian"],
    agent: agent({ model: "claude-sonnet-5", prompt: "Research the topic I give you and write your findings, with sources, to ~/Desktop/notes.md.", permissions: { internet: true, terminal: false, writeFiles: true, installPackages: false } }),
  },
  {
    id: "ai-bug-fixer", category: "ai", name: "Autonomous Bug Fixer", sizeMB: 3260, image: img("bug-fixer"),
    description: "Codex with Docker and GitHub. Works through an issue queue and opens PRs.",
    apps: ["codex", "terminal", "github", "vscode", "docker"], startup: ["terminal"],
    agent: agent({ runtime: "codex", model: "gpt-5-codex", prompt: "Pick the oldest open bug, reproduce it, fix it, and open a PR.", autonomy: "auto", permissions: { internet: true, terminal: true, writeFiles: true, installPackages: true } }),
  },
  {
    id: "ai-data", category: "ai", name: "Spreadsheet Wrangler", sizeMB: 1720, image: img("data"),
    description: "Cleans, merges and charts the messy data files you attach.",
    apps: ["aider", "libreoffice", "onlyoffice", "terminal"], startup: ["libreoffice"],
    agent: agent({ runtime: "aider", model: "claude-sonnet-5", prompt: "Clean up the CSVs I attached, merge them, and chart the monthly totals." }),
  },
  {
    id: "ai-inbox", category: "ai", name: "Inbox & Docs Assistant", sizeMB: 960, image: img("inbox"),
    description: "Triages Gmail, files attachments into Drive and drafts replies.",
    apps: ["gmail", "google-drive", "google-workspace", "claude"], startup: ["gmail"],
    agent: agent({ model: "claude-haiku-4-5", prompt: "Sort today's inbox, file attachments into Drive by client, and draft replies I should send.", permissions: { internet: true, terminal: false, writeFiles: true, installPackages: false } }),
  },

  // Development
  { id: "dev-web", category: "dev", name: "Web Dev Starter", sizeMB: 2480, image: img("dev-web"), description: "VS Code, two browsers, a terminal and Postman. Node and Python preinstalled.", apps: ["vscode", "chromium", "firefox", "terminal", "github-desktop", "postman"], startup: ["vscode", "chromium"] },
  { id: "dev-jetbrains", category: "dev", name: "JetBrains Suite", sizeMB: 4310, image: img("jetbrains"), description: "IntelliJ IDEA and PyCharm with GitHub Desktop.", apps: ["intellij-idea", "pycharm", "github-desktop", "terminal"], startup: ["intellij-idea"] },
  { id: "dev-godot", category: "dev", name: "Indie Game Dev", sizeMB: 3890, image: img("game-dev"), description: "Godot, Aseprite, Tiled and Piskel for 2D games from sprite to build.", apps: ["godot", "aseprite", "tiled", "piskel", "github"], startup: ["godot"] },
  { id: "dev-android", category: "dev", name: "Android Studio", sizeMB: 7040, image: img("android"), description: "Android Studio with the SDK and an emulator image ready to go.", apps: ["android-studio", "vscode", "github"], startup: ["android-studio"] },
  { id: "dev-containers", category: "dev", name: "Container Lab", sizeMB: 2210, image: img("containers"), description: "Docker, code-server and Postman to poke at services safely.", apps: ["docker", "code-server", "terminal", "postman"], startup: ["docker", "terminal"] },
  { id: "dev-network", category: "dev", name: "Network Toolkit", sizeMB: 1480, image: img("network"), description: "Wireshark, FileZilla and Remmina for sniffing, moving and remoting.", apps: ["wireshark", "filezilla", "remmina", "terminal"], startup: ["wireshark"] },
  { id: "dev-kali", category: "dev", name: "Kali Linux", sizeMB: 6120, image: img("kali"), description: "A full Kali desktop for security testing, isolated from your machine.", apps: ["kali-linux", "wireshark", "terminal", "firefox"], startup: ["kali-linux"] },

  // Creative
  { id: "cr-design", category: "creative", name: "Design Studio", sizeMB: 2650, image: img("design"), description: "Inkscape, GIMP, Krita and Figma for vector, raster and UI work.", apps: ["inkscape", "gimp", "krita", "figma"], startup: ["inkscape"] },
  { id: "cr-3d", category: "creative", name: "3D & CAD", sizeMB: 4720, image: img("3d"), description: "Blender for art, FreeCAD and KiCad for parts and boards.", apps: ["blender", "freecad", "kicad", "gimp"], startup: ["blender"] },
  { id: "cr-darkroom", category: "creative", name: "Photo Darkroom", sizeMB: 2380, image: img("darkroom"), description: "darktable, RawTherapee and digiKam for RAW editing and your library.", apps: ["darktable", "rawtherapee", "digikam", "gimp"], startup: ["darktable"] },
  { id: "cr-video", category: "creative", name: "Video Edit Bay", sizeMB: 3560, image: img("video"), description: "Kdenlive, Shotcut and OpenShot, with OBS to capture.", apps: ["kdenlive", "shotcut", "openshot", "obs"], startup: ["kdenlive"] },
  { id: "cr-podcast", category: "creative", name: "Podcast Booth", sizeMB: 1340, image: img("podcast"), description: "Record in Ardour or Audacity, bring guests in over Zoom.", apps: ["audacity", "ardour", "obs", "zoom"], startup: ["audacity"] },
  { id: "cr-printing", category: "creative", name: "3D Print Shop", sizeMB: 2940, image: img("printing"), description: "OrcaSlicer, Bambu Studio and Cura, with FreeCAD for tweaks.", apps: ["orcaslicer", "bambustudio", "cura", "freecad"], startup: ["orcaslicer"] },

  // Focus
  { id: "fo-deep-work", category: "focus", name: "Deep Work Desk", sizeMB: 820, image: img("deep-work"), description: "Obsidian, Notion and music. Pairs well with a focus session.", apps: ["obsidian", "notion", "spotify"], startup: ["obsidian", "spotify"] },
  { id: "fo-writers-room", category: "focus", name: "Writer's Room", sizeMB: 1150, image: img("writers"), description: "LibreOffice, Obsidian and a plain text editor. No browser, no feeds.", apps: ["libreoffice", "obsidian", "text-editor"], startup: ["libreoffice"] },
  { id: "fo-study", category: "focus", name: "Study Den", sizeMB: 1020, image: img("study"), description: "Zotero, calibre and Obsidian. Built for exam season.", apps: ["zotero", "calibre", "obsidian", "chromium"], startup: ["zotero"] },

  // Games
  { id: "ga-retro", category: "games", name: "Retro Arcade", sizeMB: 3180, image: img("retro"), description: "RetroArch, Dolphin and ScummVM. Bring your own ROMs.", apps: ["retroarch", "dolphin", "scummvm"], startup: ["retroarch"] },
  { id: "ga-pocket", category: "games", name: "Pocket Arcade", sizeMB: 380, instant: true, image: img("retro"), description: "Luanti and ScummVM. Cached on every machine, so it's ready while something bigger downloads.", apps: ["luanti", "scummvm"], startup: ["luanti"] },
  { id: "ga-steam", category: "games", name: "Steam Box", sizeMB: 8200, image: img("steam"), description: "Steam and Luanti, streamed from a machine with a real GPU.", apps: ["steam", "luanti", "discord"], startup: ["steam"] },

  // Everyday
  { id: "ev-browser", category: "everyday", name: "Disposable Browser", sizeMB: 540, instant: true, image: img("browser"), description: "A clean Firefox that forgets everything the moment you discard it.", apps: ["firefox"], startup: ["firefox"] },
  { id: "ev-private", category: "everyday", name: "Private Browsing", sizeMB: 910, image: img("private"), description: "Mullvad Browser, LibreWolf and Brave, kept off your real machine.", apps: ["mullvad-browser", "librewolf", "brave"], startup: ["mullvad-browser"] },
  { id: "ev-chat", category: "everyday", name: "Chat Hub", sizeMB: 1120, image: img("chat"), description: "Signal, Telegram and Discord in one place.", apps: ["signal", "telegram", "discord"], startup: ["signal", "telegram"] },
  { id: "ev-meetings", category: "everyday", name: "Meeting Room", sizeMB: 1260, image: img("meetings"), description: "Zoom, Slack and Workspace, kept apart from your real desktop.", apps: ["zoom", "slack", "google-workspace"], startup: ["zoom", "slack"] },
];

export const templateById = (id: string) => TEMPLATES.find((t) => t.id === id);

/** Search across a template's name, description, category and the names of its apps. */
export function templateMatches(t: Template, query: string, catalog: App[]) {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const category = CATEGORIES.find((c) => c.value === t.category)?.label ?? "";
  const hay = [t.name, t.description, category, ...templateApps(t, catalog).map((a) => a.name)].join(" ").toLowerCase();
  return needle.split(/\s+/).every((word) => hay.includes(word));
}

/** A template's apps, resolved from the catalog, in desktop order. */
export const templateApps = (t: Template, catalog: App[]) => t.apps.map((id) => catalog.find((a) => a.id === id)).filter((a): a is App => !!a);
export const appIcon = (a: App) => a.iconUrl ?? favicon(a.domain);

/** The desktop a template boots into, built from the app catalog. */
export function templateLayout(t: Template, catalog: App[]): Layout {
  const icons: LayoutIcon[] = templateApps(t, catalog).map((app, row) => ({
    id: `${app.id}-0-${row}`, appId: app.id, label: app.name, iconUrl: appIcon(app), color: app.color, x: 0, y: 0, cell: { col: 0, row }, ...(t.startup?.includes(app.id) && { autostart: true }),
  }));
  return { grid: true, wallpaper: { type: "image", value: t.image }, icons };
}
