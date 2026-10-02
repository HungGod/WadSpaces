// The six hand-written workspaces in Wadspaces-David, as generator specs.
// Used when a workspace on the machine has no library copy yet.
//
// Their repos are default projects now. Project ids belong to each user, so a
// preset carries drafts (PRESET_PROJECTS); the data layer finds or creates the
// user's matching projects and puts their ids in advanced.projects.
import { recipeFor } from "./catalog/recipes";
import { defaultAdvanced, type WadspaceSpec } from "./model";
import type { ProjectDraft } from "./projects";
import { PRESET_DESKTOPS } from "./presetDesktops";
import { type CreatorSpec, newSpec } from "./spec";

const gh = (repo: string, mountName: string, setup = ""): ProjectDraft => ({
  name: mountName,
  mountName,
  source: { kind: "git", url: `https://github.com/HungGod/${repo}.git` },
  setup,
});
const kale = (...pairs: [string, string][]) => pairs.map(([app_name, app_url]) => ({ app_name, app_url }));
const KALE_DEV = kale(["Github", "https://github.com"], ["Claude", "https://claude.ai"], ["Open Router", "https://openrouter.ai/"]);
const web = (...pairs: [string, string][]) => pairs.map(([name, url]) => ({ name, url }));

export const PRESETS: CreatorSpec[] = [
  newSpec({ id: "writing", name: "Writing", features: ["git", "obsidian"], port: 3100, hotkey: 1, persistConfig: false, display: "host" }),
  newSpec({
    id: "iq-dev", name: "IntelligenceQuest Dev", port: 3110, hotkey: 2, display: "host",
    features: ["git", "cpp", "python", "nodejs", "vscode", "claude-code", "tiled"],
    kaleResources: kale(["Spritesheet Packer", "https://www.codeandweb.com/free-sprite-sheet-packer"], ["Github", "https://github.com"], ["Claude", "https://claude.ai"], ["Piskel", "https://www.piskelapp.com/"]),
  }),
  newSpec({
    id: "wad-c", name: "Wad Creator Dev", port: 3120, hotkey: 3, display: "host",
    features: ["git", "nodejs", "firebase", "vscode", "claude-code", "chrome"],
    webapps: web(["Claude", "https://claude.ai"], ["GitHub", "https://github.com"], ["Google Cloud", "https://console.cloud.google.com"], ["OpenRouter", "https://openrouter.ai"]),
  }),
  newSpec({
    id: "kale-b", name: "Kale Browser", port: 3130, hotkey: 4, display: "host",
    features: ["git", "python", "nodejs", "vscode", "claude-code"],
    kaleResources: KALE_DEV,
  }),
  newSpec({
    id: "vanua-academy", name: "Vanua Academy", port: 3140, hotkey: 5, display: "host",
    features: ["git", "python", "nodejs", "firebase", "vscode", "claude-code", "chrome", "hplip"],
    webapps: web(["Gmail", "https://mail.google.com"], ["Claude", "https://claude.ai"], ["GitHub", "https://github.com"], ["Google Cloud", "https://console.cloud.google.com"], ["Google Workspace", "https://workspace.google.com/dashboard"], ["Google Drive", "https://drive.google.com"]),
  }),
  newSpec({
    id: "kale-p", name: "Kale Phone", port: 3150, hotkey: 6, display: "host", devices: ["/dev/dri", "/dev/kvm"],
    features: ["git", "nodejs", "vscode", "claude-code", "android-studio"],
    kaleResources: KALE_DEV,
  }),
];

export const preset = (id: string) => PRESETS.find((p) => p.id === id);

/** Each preset's default projects. Writing's folder must stay "Writing": the
 *  image's init-writing-vault looks for ~/Desktop/Writing. */
export const PRESET_PROJECTS: Record<string, ProjectDraft[]> = {
  writing: [gh("Writing", "Writing")],
  "iq-dev": [gh("intelligencequest", "IntelligenceQuest")],
  "wad-c": [gh("WadCreator", "WadCreator", "npm install")],
  "kale-b": [gh("KaleBrowser", "KaleBrowser", "npm install")],
  "vanua-academy": [gh("VanuaAcademy", "VanuaAcademy", "npm run install:all")],
  "kale-p": [gh("KalePhone", "KalePhone")],
};

export const presetProjects = (id: string): ProjectDraft[] => PRESET_PROJECTS[id] ?? [];


/** A preset as a Builder wadspace: its real desktop plus its build and run
 *  settings. advanced.projects is empty: the data layer fills it in from
 *  presetProjects(). */
export function presetWadspace(id: string): WadspaceSpec | undefined {
  const p = preset(id);
  const desk = PRESET_DESKTOPS[id];
  if (!p || !desk) return undefined;
  // Features an icon already brings in don't need listing as tools.
  const fromIcons = new Set(
    desk.layout.icons.map((i) => recipeFor(i.appId)).flatMap((r) => (r.kind === "feature" ? [r.feature] : [])),
  );
  return {
    id: p.id,
    name: p.name,
    description: desk.description,
    layout: desk.layout,
    advanced: {
      ...defaultAdvanced(p.env.TZ),
      display: p.display ?? "stream",
      port: p.port,
      hotkey: p.hotkey ?? null,
      tools: p.features.filter((f) => !fromIcons.has(f)),
      projects: [],
      env: p.env,
      secrets: p.secrets,
      devices: p.devices,
      shmSize: p.shmSize,
      persistConfig: p.persistConfig,
      autostart: p.autostart,
    },
  };
}
