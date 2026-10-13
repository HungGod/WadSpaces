// The sample library for the app's tests, on the fake backend: the starters
// (Writing, Dev), an Extensions layer on Dev with web apps and Claude Code, a
// stack on each (Cosmic on Writing, VanuaAcademy on the Extensions), a saved
// WadBrowser setup, saved sign-ins (some shared) and the layer images built.
// `legacyBackend` has the same library as it was before stacks (version 2),
// to move. Sign-in names are made up (images/examples has the real
// VanuaAcademy's).
import { extensionsLayer, templateLayer, webappId, type BrowserSetup, type Extensions, type SignInRef, type Template, type Wadspace, type WadspaceV2 } from "@core/layers";
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
  const vanuaDev: Extensions = {
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
    version: 3,
    id: "cosmic-bodybuilding",
    owner: "me",
    order: 1,
    template: "writing",
    customization: {
      name: "Cosmic Bodybuilding",
      description: "Writing Cosmic Bodybuilding.",
      wallpaper: { type: "image", value: "/wallpapers/cosmic-bodybuilding.png" },
      projects: [{ id: "writing", kind: "github", repo: "HungGod/Writing", as: "Writing" }],
      secrets: { bySlot: {} },
    },
    createdAt: at(9),
    updatedAt: at(9),
  };
  const vanua: Wadspace = {
    version: 3,
    id: "vanua-academy",
    owner: "me",
    order: 2,
    template: "dev",
    extensions: vanuaDev.id,
    customization: {
      name: "VanuaAcademy",
      description: "Building Vanua Academy.",
      wallpaper: { type: "image", value: "/wallpapers/vanua-academy.png" },
      projects: [{ id: "vanua-academy", kind: "github", repo: "HungGod/VanuaAcademy", as: "VanuaAcademy", setup: "npm ci" }],
      secrets: {
        bySlot: { "ext:anthropic.claude-code": SIGNINS.claudeCode },
        groups: [
          { id: "all", members: ["browser"] },
          { id: "g-s-github", members: ["web:github"], key: SIGNINS.github },
          { id: "g-s-claude", members: ["web:claude"], key: SIGNINS.claude },
          { id: "g-s-google", members: ["web:google-firebase", "web:google-cloud"], key: SIGNINS.google },
          { id: "g-s-workspace", members: ["web:gmail", "web:google-drive", "web:google-workspace"], key: SIGNINS.workspace },
        ],
      },
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
  b.extensions.set(vanuaDev.id, vanuaDev);
  for (const w of [cosmic, vanua]) b.wadspaces.set(w.id, w);
  b.browsers.set(vanuaMail.id, vanuaMail);
  b.startersCreated = true;
  b.signIns = Object.values(SIGNINS).map((s) => ({ id: s.id, name: s.name, app: s.kind, paths: [], createdAt: 0, size: 0, changedAt: null, usedBy: [], inUse: [] }));
  const project = (id: string, name: string): Project => ({ id, name, mountName: name, source: { kind: "git", url: `https://github.com/HungGod/${name}` }, setup: "", deleted: false, createdAt: 0, updatedAt: 0 }) as Project;
  b.projects = [project("writing", "Writing"), { ...project("vanua-academy", "VanuaAcademy"), setup: "npm ci" }];
  // The images built: the starters' and the Extensions', on Dev's.
  const tw = { layer: "template:writing" as const, ref: "localhost/wadspaces-template-writing:latest", id: "img-writing", dockerfileSha: templateLayer(writing).sha, builtAt: Date.parse(at(29)) / 1000, sizeMb: 1650, from: "base" };
  const td = { layer: "template:dev" as const, ref: "localhost/wadspaces-template-dev:latest", id: "img-dev", dockerfileSha: templateLayer(dev).sha, builtAt: Date.parse(at(29)) / 1000, sizeMb: 2400, from: "base" };
  const cv = { layer: "custom:vanua-academy-dev" as const, ref: "localhost/wadspaces-custom-vanua-academy-dev:latest", id: "img-vanua-dev", dockerfileSha: extensionsLayer(vanuaDev, dev).sha, builtAt: Date.parse(at(12)) / 1000, sizeMb: 2650, from: "img-dev" };
  for (const row of [tw, td, cv]) b.images.set(row.layer, row);
  const repo = (name: string, priv = true) => ({ fullName: `HungGod/${name}`, name, private: priv, url: `https://github.com/HungGod/${name}`, defaultBranch: "main", pushedAt: at(2), description: null });
  b.repos = [repo("Writing"), repo("VanuaAcademy"), repo("WadSpaces", false)];
  b.folders = {
    "/var/home/wad": { dirs: ["/var/home/wad/Notes", "/var/home/wad/Pictures"], files: ["/var/home/wad/todo.md"] },
    "/var/home/wad/Notes": { dirs: [], files: ["/var/home/wad/Notes/ideas.md", "/var/home/wad/Notes/plan.md"] },
    "/var/home/wad/Pictures": { dirs: [], files: ["/var/home/wad/Pictures/beach.jpg"] },
  };
  return b;
}

/** The sample library as it was before stacks: the Extensions layer kept as a
 *  customization, and version 2 wadspaces (Cosmic's project a folder here). */
export function legacyBackend(): FakeBackend {
  const b = sampleBackend();
  const vanuaDev = b.extensions.get("vanua-academy-dev")!;
  b.extensions.clear();
  b.customizations.set(vanuaDev.id, vanuaDev);
  const old = (w: Wadspace, base: WadspaceV2["base"], secrets: WadspaceV2["secrets"]): WadspaceV2 => ({
    version: 2,
    id: w.id,
    owner: w.owner,
    name: w.customization!.name,
    description: w.customization!.description,
    base,
    wallpaper: w.customization!.wallpaper,
    projects: w.customization!.projects.map((p) => p.id),
    secrets,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  });
  const cosmic = b.wadspaces.get("cosmic-bodybuilding") as Wadspace;
  const vanua = b.wadspaces.get("vanua-academy") as Wadspace;
  const groups = vanua.customization!.secrets.groups!;
  const web = Object.fromEntries(groups.flatMap((g) => (g.key ? g.members.map((m) => [m, g.key!]) : [])));
  b.wadspaces.set(cosmic.id, old(cosmic, { kind: "template", id: "writing" }, {}));
  b.wadspaces.set(vanua.id, old(vanua, { kind: "customization", id: vanuaDev.id }, { ...vanua.customization!.secrets.bySlot, ...web }));
  b.projects = [
    { ...b.projects[0], source: { kind: "folder", machineId: "local", machineName: "Here", path: "/home/me/Writing" } } as Project,
    b.projects[1],
  ];
  return b;
}
