// The six hand-written workspaces in WadSpaces/containers, as editor specs.
// Used when a workspace on the machine has no library copy yet.
import { type CreatorSpec, newSpec } from "./spec";

const gh = (repo: string, dest: string, postClone?: string) => ({ url: `https://github.com/HungGod/${repo}.git`, dest, postClone });
const kale = (...pairs: [string, string][]) => pairs.map(([app_name, app_url]) => ({ app_name, app_url }));
const KALE_DEV = kale(["Github", "https://github.com"], ["Claude", "https://claude.ai"], ["Open Router", "https://openrouter.ai/"]);
const web = (...pairs: [string, string][]) => pairs.map(([name, url]) => ({ name, url }));

export const PRESETS: CreatorSpec[] = [
  newSpec({ id: "writing", name: "Writing", features: ["git", "obsidian"], repos: [gh("Writing", "Writing")], port: 3100, hotkey: 1, persistConfig: false }),
  newSpec({
    id: "iq-dev", name: "IntelligenceQuest Dev", port: 3110, hotkey: 2,
    features: ["git", "cpp", "python", "nodejs", "vscode", "claude-code", "tiled"],
    repos: [gh("intelligencequest", "IntelligenceQuest")],
    kaleResources: kale(["Spritesheet Packer", "https://www.codeandweb.com/free-sprite-sheet-packer"], ["Github", "https://github.com"], ["Claude", "https://claude.ai"], ["Piskel", "https://www.piskelapp.com/"]),
  }),
  newSpec({
    id: "wad-c", name: "Wad Creator Dev", port: 3120, hotkey: 3,
    features: ["git", "nodejs", "firebase", "vscode", "claude-code", "chrome"],
    repos: [gh("WadCreator", "WadCreator", "npm install")],
    webapps: web(["Claude", "https://claude.ai"], ["GitHub", "https://github.com"], ["Google Cloud", "https://console.cloud.google.com"], ["OpenRouter", "https://openrouter.ai"]),
  }),
  newSpec({
    id: "kale-b", name: "Kale Browser", port: 3130, hotkey: 4,
    features: ["git", "python", "nodejs", "vscode", "claude-code"],
    repos: [gh("KaleBrowser", "KaleBrowser", "npm install")], kaleResources: KALE_DEV,
  }),
  newSpec({
    id: "vanua-academy", name: "Vanua Academy", port: 3140, hotkey: 5,
    features: ["git", "python", "nodejs", "firebase", "vscode", "claude-code", "chrome", "hplip"],
    repos: [gh("VanuaAcademy", "VanuaAcademy", "npm run install:all")],
    webapps: web(["Gmail", "https://mail.google.com"], ["Claude", "https://claude.ai"], ["GitHub", "https://github.com"], ["Google Cloud", "https://console.cloud.google.com"], ["Google Workspace", "https://workspace.google.com/dashboard"], ["Google Drive", "https://drive.google.com"]),
  }),
  newSpec({
    id: "kale-p", name: "Kale Phone", port: 3150, hotkey: 6, devices: ["/dev/dri", "/dev/kvm"],
    features: ["git", "nodejs", "vscode", "claude-code", "android-studio"],
    repos: [gh("KalePhone", "KalePhone")], kaleResources: KALE_DEV,
  }),
];

export const preset = (id: string) => PRESETS.find((p) => p.id === id);
