// The sample library for the app's tests, on the fake
// backend: the starters (Writing, Dev), a customization of Dev with web apps
// and Claude Code, a wadspace on each kind of base, a saved WadBrowser setup,
// saved sign-ins (some shared) and the layer images built. Sign-in names are
// made up (images/examples has the real VanuaAcademy's).
import { customizationLayer, templateLayer, webappId, type BrowserSetup, type Customization, type SignInRef, type Template, type Wadspace } from "@core/layers";
import type { Project } from "@core/projects";
import { FakeBackend } from "./fakeBackend";

const day = 86_400_000;
const at = (daysAgo: number) => new Date(Date.parse("2026-10-01T00:00:00.000Z") - daysAgo * day).toISOString();
const web = (name: string, url: string) => ({ id: webappId(name), name, url });

export const GOOGLE = "work@example.com-WadBrowser-Google";
export const WORKSPACE = "team@example.com-WadBrowser-Google";
export const CLAUDE_CODE = "me@example.com-VSCode-ClaudeCode";

const ref = (id: string, name: string, kind: SignInRef["kind"]): SignInRef => ({ id, name, kind });
const SIGNINS = {
  claudeCode: ref("s-claude-code", CLAUDE_CODE, "vscode-claude-code"),
  github: ref("s-github", "Me-WadBrowser-Github", "web"),
  claude: ref("s-claude", "VanuaAcademy-WadBrowser-Claude", "web"),
  google: ref("s-google", GOOGLE, "web"),
  workspace: ref("s-workspace", WORKSPACE, "web"),
};

/** A fake backend with the sample library in it. */
export function sampleBackend(target: "offline" | "online" | "machine" = "offline"): FakeBackend {
  const b = new FakeBackend({ target });
  const writing: Template = { id: "writing", owner: "me", name: "Writing", description: "Obsidian, for notes and long-form writing.", apps: ["obsidian"], starter: true, createdAt: at(30), updatedAt: at(30) };
  const dev: Template = { id: "dev", owner: "me", name: "Dev", description: "WadBrowser and VS Code, for building things.", apps: ["wadbrowser", "vscode"], starter: true, createdAt: at(30), updatedAt: at(30) };
  const vanuaDev: Customization = {
    id: "vanua-academy-dev",
    owner: "me",
    name: "VanuaAcademy Dev",
    description: "Dev with Claude Code, the Firebase CLI and VanuaAcademy's web apps.",
    templateId: "dev",
    browserMode: "browser",
    webapps: [
      web("GitHub", "https://github.com"),
      web("Claude", "https://claude.ai"),
      web("Google FireBase", "https://firebase.google.com"),
      web("Google Cloud", "https://cloud.google.com"),
      web("Gmail", "https://mail.google.com"),
      web("Google Drive", "https://drive.google.com"),
      web("Google Workspace", "https://workspace.google.com"),
    ],
    extensions: ["anthropic.claude-code"],
    tools: ["firebase"],
    autostart: [],
    createdAt: at(12),
    updatedAt: at(12),
  };
  const cosmic: Wadspace = {
    version: 2,
    id: "cosmic-bodybuilding",
    owner: "me",
    name: "Cosmic Bodybuilding",
    description: "Writing Cosmic Bodybuilding.",
    base: { kind: "template", id: "writing" },
    wallpaper: { type: "image", value: "/wallpapers/cosmic-bodybuilding.png" },
    projects: ["writing"],
    secrets: {},
    createdAt: at(9),
    updatedAt: at(9),
  };
  const vanua: Wadspace = {
    version: 2,
    id: "vanua-academy",
    owner: "me",
    name: "VanuaAcademy",
    description: "Building Vanua Academy.",
    base: { kind: "customization", id: vanuaDev.id },
    wallpaper: { type: "image", value: "/wallpapers/vanua-academy.png" },
    projects: ["vanua-academy"],
    secrets: {
      "ext:anthropic.claude-code": SIGNINS.claudeCode,
      "web:github": SIGNINS.github,
      "web:claude": SIGNINS.claude,
      "web:google-firebase": SIGNINS.google,
      "web:google-cloud": SIGNINS.google,
      "web:gmail": SIGNINS.workspace,
      "web:google-drive": SIGNINS.workspace,
      "web:google-workspace": SIGNINS.workspace,
    },
    createdAt: at(5),
    updatedAt: at(5),
  };
  // Mail and files on their own, in Focus, sharing the Workspace sign-in.
  const vanuaMail: BrowserSetup = {
    id: "vanua-academy-mail",
    owner: "me",
    name: "VanuaAcademy Mail",
    mode: "focus",
    webapps: [web("Gmail", "https://mail.google.com"), web("Google Drive", "https://drive.google.com")],
    secrets: { "web:gmail": SIGNINS.workspace, "web:google-drive": SIGNINS.workspace },
    createdAt: at(4),
    updatedAt: at(4),
  };
  for (const t of [writing, dev]) b.templates.set(t.id, t);
  b.customizations.set(vanuaDev.id, vanuaDev);
  for (const w of [cosmic, vanua]) b.wadspaces.set(w.id, w);
  b.browsers.set(vanuaMail.id, vanuaMail);
  b.startersCreated = true;
  b.signIns = Object.values(SIGNINS).map((s) => ({ id: s.id, name: s.name, app: s.kind, paths: [], createdAt: 0, size: 0, changedAt: null, usedBy: [], inUse: [] }));
  const project = (id: string, name: string): Project => ({ id, name, mountName: name, source: { kind: "folder", path: `/home/me/${name}` }, setup: "", deleted: false, createdAt: 0, updatedAt: 0 }) as Project;
  b.projects = [project("writing", "Writing"), project("vanua-academy", "VanuaAcademy")];
  // The images built: the starters' and the customization's, on Dev's.
  const tw = { layer: "template:writing" as const, ref: "localhost/wadspaces-template-writing:latest", id: "img-writing", dockerfileSha: templateLayer(writing).sha, builtAt: Date.parse(at(29)) / 1000, sizeMb: 1650, from: "base" };
  const td = { layer: "template:dev" as const, ref: "localhost/wadspaces-template-dev:latest", id: "img-dev", dockerfileSha: templateLayer(dev).sha, builtAt: Date.parse(at(29)) / 1000, sizeMb: 2400, from: "base" };
  const cv = { layer: "custom:vanua-academy-dev" as const, ref: "localhost/wadspaces-custom-vanua-academy-dev:latest", id: "img-vanua-dev", dockerfileSha: customizationLayer(vanuaDev, dev).sha, builtAt: Date.parse(at(12)) / 1000, sizeMb: 2650, from: "img-dev" };
  for (const row of [tw, td, cv]) b.images.set(row.layer, row);
  return b;
}
