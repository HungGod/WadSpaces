// How each app in the catalog (apps.json) gets into a real wadspace image.
//
//   feature   an existing `wadspaces-feature` script in Wadspaces-David/_common;
//             `desktop` is the launcher it writes (add_desktop_entry)
//   apt       Debian trixie packages, installed by `wadspaces-apt`; `desktop`
//             names the launcher to put on the desktop (otherwise the helper
//             takes the first new one in /usr/share/applications)
//   webapp    a Chrome --app window (`wadspaces-webapp`); pulls in chrome
//   builtin   already in the base image
//   soon      not installable yet (third-party repo, AI agent, ...): shown in
//             the catalog with a "Coming soon" badge and skipped by builds
import type { FeatureId } from "../spec";

export type Recipe =
  | { kind: "feature"; feature: FeatureId; desktop: string[] }
  | { kind: "apt"; packages: string[]; desktop?: string }
  | { kind: "webapp"; url: string }
  | { kind: "builtin"; desktop: string }
  | { kind: "soon"; reason: string };

const feature = (f: FeatureId, ...desktop: string[]): Recipe => ({ kind: "feature", feature: f, desktop });
const apt = (packages: string | string[], desktop?: string): Recipe => ({ kind: "apt", packages: [packages].flat(), desktop });
const web = (url: string): Recipe => ({ kind: "webapp", url });
const soon = (reason: string): Recipe => ({ kind: "soon", reason });

const AGENT = "AI agents are coming soon";
const THIRD_PARTY = "Needs a third-party package source; coming soon";

export const RECIPES: Record<string, Recipe> = {
  // Browsers
  chrome: feature("chrome", "wadspaces-chrome.desktop"),
  firefox: apt("firefox-esr", "firefox-esr.desktop"),
  chromium: apt("chromium", "chromium.desktop"),
  brave: soon(THIRD_PARTY),
  librewolf: soon(THIRD_PARTY),
  "mullvad-browser": soon(THIRD_PARTY),
  vivaldi: soon(THIRD_PARTY),

  // Development
  vscode: feature("vscode", "wadspaces-vscode.desktop"),
  terminal: { kind: "builtin", desktop: "foot.desktop" },
  "text-editor": apt("mousepad", "org.xfce.mousepad.desktop"),
  "android-studio": feature("android-studio", "wadspaces-android-studio.desktop"),
  tiled: feature("tiled", "wadspaces-tiled.desktop"),
  github: web("https://github.com"),
  "google-cloud": web("https://console.cloud.google.com"),
  openrouter: web("https://openrouter.ai"),
  postman: web("https://web.postman.co"),
  docker: soon(THIRD_PARTY),
  godot: soon(THIRD_PARTY),
  unity: soon(THIRD_PARTY),
  "code-server": soon(THIRD_PARTY),
  vscodium: soon(THIRD_PARTY),
  "intellij-idea": soon(THIRD_PARTY),
  pycharm: soon(THIRD_PARTY),
  "github-desktop": soon(THIRD_PARTY),
  wireshark: apt("wireshark", "org.wireshark.Wireshark.desktop"),
  filezilla: apt("filezilla"),
  remmina: apt("remmina", "org.remmina.Remmina.desktop"),
  "kali-linux": soon("Kali tools don't fit a Debian desktop image"),

  // AI (the harnesses arrive with AI agents)
  "claude-code": feature("claude-code", "wadspaces-claude-code.desktop"),
  claude: web("https://claude.ai"),
  deepseek: web("https://chat.deepseek.com"),
  codex: soon(AGENT),
  "gemini-cli": soon(AGENT),
  opencode: soon(AGENT),
  "qwen-code": soon(AGENT),
  aider: soon(AGENT),
  "lm-studio": soon(AGENT),

  // Creative
  gimp: apt("gimp", "gimp.desktop"),
  krita: apt("krita", "org.kde.krita.desktop"),
  inkscape: apt("inkscape", "org.inkscape.Inkscape.desktop"),
  blender: apt("blender", "blender.desktop"),
  figma: web("https://www.figma.com/files"),
  aseprite: soon(THIRD_PARTY),
  "spritesheet-packer": web("https://www.codeandweb.com/free-sprite-sheet-packer"),
  piskel: web("https://www.piskelapp.com/"),
  audacity: apt("audacity", "audacity.desktop"),
  obs: apt("obs-studio", "com.obsproject.Studio.desktop"),
  ardour: apt("ardour"),
  kdenlive: apt("kdenlive", "org.kde.kdenlive.desktop"),
  shotcut: apt("shotcut", "org.shotcut.Shotcut.desktop"),
  openshot: apt("openshot-qt", "org.openshot.OpenShot.desktop"),
  darktable: apt("darktable", "org.darktable.darktable.desktop"),
  digikam: apt("digikam", "org.kde.digikam.desktop"),
  rawtherapee: apt("rawtherapee", "rawtherapee.desktop"),
  freecad: apt("freecad"),
  kicad: apt("kicad", "org.kicad.kicad.desktop"),
  orcaslicer: soon(THIRD_PARTY),
  bambustudio: soon(THIRD_PARTY),
  cura: soon(THIRD_PARTY),

  // Focus, office and study
  obsidian: feature("obsidian", "md.obsidian.Obsidian.desktop"),
  notion: web("https://www.notion.so"),
  libreoffice: apt("libreoffice", "libreoffice-startcenter.desktop"),
  onlyoffice: soon(THIRD_PARTY),
  zotero: web("https://www.zotero.org/mylibrary"),
  calibre: apt("calibre", "calibre-gui.desktop"),
  "google-drive": web("https://drive.google.com"),
  gmail: web("https://mail.google.com"),
  "google-workspace": web("https://workspace.google.com/dashboard"),

  // Chat and meetings
  slack: web("https://app.slack.com/client"),
  discord: web("https://discord.com/app"),
  zoom: web("https://app.zoom.us/wc"),
  telegram: apt("telegram-desktop", "org.telegram.desktop.desktop"),
  signal: soon(THIRD_PARTY),
  spotify: web("https://open.spotify.com"),

  // Games
  steam: soon(THIRD_PARTY),
  retroarch: apt("retroarch"),
  dolphin: apt("dolphin-emu", "dolphin-emu.desktop"),
  scummvm: apt("scummvm", "org.scummvm.scummvm.desktop"),
  luanti: apt("luanti"),
};

/** Custom apps from the Builder's "Custom app" dialog are websites. */
export function recipeFor(appId: string, domain?: string): Recipe {
  const r = RECIPES[appId];
  if (r) return r;
  if (domain) return web(/^https?:\/\//.test(domain) ? domain : `https://${domain}`);
  return soon("Unknown app");
}

export const isInstallable = (r: Recipe) => r.kind !== "soon";

// Debian package names: what apt accepts, nothing a shell would read.
export const PACKAGE_RE = /^[a-z0-9][a-z0-9+.-]+$/;
