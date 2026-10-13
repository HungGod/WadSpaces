// The golden corpus for wad-core: every core function, over inputs chosen to
// cover its branches and the awkward cases (Unicode, quoting, YAML scalars,
// env order, empty values). fixtures/core/goldens.json holds what the core
// returned for each; the Rust core (crates/wad-core) must return the same,
// byte for byte. goldens.test.ts writes and checks them.
//
// A case is a function name and its arguments as JSON. Bytes (tar archives,
// wallpapers) are {"$bytes": base64}. A function that throws gives {"err"}.
import type { WaddSpec } from "./spec";
import type { Project, ProjectDraft } from "./projects";
import type { BrowserSetup, Customization, KeyGroup, Setup, Template, Wadspace, WadspaceV3 } from "./layers";

export interface Case {
  fn: string;
  args: unknown[];
}

const project = (id: string, p: Partial<Project> = {}): Project => ({
  id,
  name: id,
  mountName: id,
  source: { kind: "git", url: `https://github.com/HungGod/${id}` },
  setup: "",
  deleted: false,
  createdAt: 1,
  updatedAt: 2,
  ...p,
});

const PROJECTS: Project[] = [
  project("notes", { name: "Notes", mountName: "Notes" }),
  project("web", { name: "Web app", mountName: "Web", setup: "npm ci" }),
  project("gone", { deleted: true }),
  project("photos", { name: "Photos", mountName: "Photos", source: { kind: "drive", uuid: "1234-ABCD", label: "Photos", fstype: "exfat", subpath: "2026" } }),
  project("here", { name: "Here", mountName: "Here", source: { kind: "folder", machineId: "m1", machineName: "Surface", path: "/var/home/wad/Here" } }),
  project("old", { legacy: true, source: { kind: "folder", machineId: "", machineName: "", path: "" } }),
];

const WADD: WaddSpec[] = [
  { id: "a", name: "A", image: "i", port: 3100 },
  { id: "n", name: "Native", image: "i", display: "host", hotkey: 2, env: { Z: "1", A: "2", M: "x y" }, secrets: ["s1", "s2"], volumes: ["v:/config:z"], devices: ["/dev/dri"], shm_size: "1g", enabled: true, autostart: true },
  { id: "p", name: "Projects", image: "i", port: 3101, container_name: "custom", container_port: 8000, projects: [{ id: "wrtvault0000000000ab", mount: "Writing" }, { id: "dr", mount: "Photos", path: "/run/media/photos" }] },
  { id: "q", name: "Quotes: \"yes\" #1", image: "ghcr.io/x/y:latest", port: 3102, hotkey: null, icon: null, env: { TRUE: "true", NUM: "3100", COLON: "a:b", SPACE: "a b", EMPTY: "", NULLISH: "null", YES: "yes", HASH: "#x" }, shm_size: null },
  { id: "h", name: "Host projects", image: "i", display: "host", projects: [{ id: "x1", mount: "X" }] },
];

const DRAFTS: ProjectDraft[] = [
  { name: "Notes", mountName: "Notes", source: { kind: "git", url: "https://github.com/HungGod/Notes" } },
  { name: "Notes", mountName: "Notes", source: { kind: "git", url: "https://github.com/HungGod/Notes.git", ref: "main" }, setup: "npm i" },
  { name: "  ", mountName: "..", source: { kind: "git", url: "http://github.com/x/y" } },
  { name: "x".repeat(201), mountName: "a/b", source: { kind: "git", url: "https://gitlab.com/x/y", ref: "-bad" } },
  { name: "R", mountName: "R", source: { kind: "git", url: "https://github.com/x/y", ref: "a..b" } },
  { name: "R", mountName: "R", source: { kind: "git", url: "https://github.com/x/y", ref: "feature/one_2.0" } },
  { name: "F", mountName: "F", source: { kind: "folder", machineId: "m", machineName: "M", path: "relative/path" } },
  { name: "F", mountName: "F", source: { kind: "folder", machineId: "m", machineName: "M", path: " /abs/path " } },
  { name: "D", mountName: "D", source: { kind: "drive", uuid: "abc", label: "", fstype: "", subpath: "" } },
  { name: "D", mountName: "D", source: { kind: "drive", uuid: "1234-ABCD", label: "Photos", fstype: "exfat", subpath: "/x/" } },
  { name: "D", mountName: "D", source: { kind: "drive", uuid: "1234-ABCD", label: "Photos", fstype: "exfat", subpath: "a/../b" } },
  { name: "S", mountName: "S", source: { kind: "git", url: "https://github.com/a/b" }, setup: "x".repeat(4001) },
  { name: "Ünï ✓", mountName: "Ünï", source: { kind: "git", url: "https://github.com/a/b" } },
  { id: "keep", name: "  Trim me  ", mountName: " Trim ", source: { kind: "git", url: " https://github.com/a/b ", ref: "  " }, setup: "  x  " },
];

const URLS = [
  "https://github.com/you/Notes.git",
  "https://github.com/you/Notes/",
  "git@github.com:you/Notes.git",
  "ssh://git@github.com/you/Notes",
  "ssh://git@github.com:22/you/Notes.git",
  "http://github.com/you/Notes",
  "https://GitHub.com/you/Notes",
  "https://gitlab.com/you/Notes",
  "  https://github.com/you/Notes.git//  ",
  "",
  "Notes",
];

const STRINGS = ["Hello World", "  --Leading & trailing--  ", "ÜNÏCØDÉ name", "a".repeat(80), "", "!!!", "Café au lait", "ﬁle İstanbul ΣΑΣ", "tab\tand\u00a0nbsp\u2003em\ufeffbom\u0085nel"];

// The Builder's layers: templates from the catalog and from before (an old
// app, a 'soon' one), customizations, wadspaces on each kind of base.
const T = (id: string, apps: string[], extra: Partial<Template> = {}): Template => ({
  id,
  owner: "me",
  name: id[0].toUpperCase() + id.slice(1),
  description: "",
  apps,
  createdAt: `2026-01-0${apps.length}`,
  updatedAt: "2026-01-09",
  ...extra,
});
const TEMPLATES: Template[] = [
  T("writing", ["obsidian"], { starter: true }),
  T("dev", ["wadbrowser", "vscode"], { starter: true }),
  T("games", ["steam", "dolphin", "lmms", "obs"]),
  T("old", ["chrome", "vscode", "gimp", "terminal", "brave", "tiled"], { name: "Chrome + 5 apps" }),
  T("none", []),
  T("gone", ["krita"], { deletedAt: "2026-02-02" }),
];
const webapp = (name: string, url: string) => ({ id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), name, url });
const SETUPS: Setup[] = [
  { templateId: "dev", browserMode: "browser", webapps: [], extensions: [], tools: [], autostart: [] },
  {
    templateId: "dev",
    browserMode: "focus",
    webapps: [webapp("GitHub", "https://github.com"), webapp("Google Cloud", "https://console.cloud.google.com/"), webapp("Odd \"$x\"", "https://odd.example/a b")],
    extensions: ["anthropic.claude-code", "openai.chatgpt", "github.copilot-chat", "ms-python.python", "bad id;x"],
    tools: ["firebase", "go", "git", "nonsense"],
    autostart: ["app:vscode", "web:github", "app:obsidian"],
  },
  { templateId: "writing", browserMode: "browser", webapps: [webapp("Gmail", "https://mail.google.com")], extensions: ["anthropic.claude-code"], tools: ["python"], autostart: ["app:obsidian"] },
];
const C = (id: string, setup: Setup, extra: Partial<Customization> = {}): Customization => ({
  ...setup,
  id,
  owner: "me",
  name: id,
  description: "",
  createdAt: "2026-03-01",
  updatedAt: "2026-03-01",
  ...extra,
});
const CUSTOMIZATIONS: Customization[] = [C("dev-plus", SETUPS[1], { name: "Dev plus" }), C("notes-plus", SETUPS[2], { createdAt: "2026-02-01" }), C("old-c", SETUPS[1], { deletedAt: "2026-04-01" })];
const ref = (id: string, kind = "web") => ({ id, name: `${id}-name`, kind }) as Wadspace["secrets"][string];
const W2 = (id: string, base: Wadspace["base"], extra: Partial<Wadspace> = {}): Wadspace => ({
  version: 2,
  id,
  owner: "me",
  name: id,
  description: "",
  base,
  wallpaper: { type: "gradient", value: "linear-gradient(#000, #fff)" },
  projects: ["notes", "web"],
  secrets: {},
  createdAt: "2026-05-01",
  updatedAt: "2026-05-01",
  ...extra,
});
const WADSPACES: Wadspace[] = [
  W2("novel", { kind: "template", id: "writing" }, { secrets: { "app:obsidian": ref("s-obs", "obsidian") }, wallpaper: { type: "image", value: "data:image/jpeg;base64,/9j/" } }),
  W2("work", { kind: "customization", id: "dev-plus" }, {
    secrets: { "web:github": ref("s-gh"), "web:google-cloud": ref("s-g"), "ext:anthropic.claude-code": ref("s-cc", "vscode-claude-code") },
    createdAt: "2026-04-01",
  }),
  W2("odd-name", { kind: "template", id: "old" }, { name: "Line\nbreak" }),
  W2("trashed", { kind: "template", id: "dev" }, { deletedAt: "2026-06-01" }),
];
const BROWSERS: BrowserSetup[] = [
  { id: "mail", owner: "me", name: "Mail", mode: "focus", webapps: [webapp("Gmail", "https://mail.google.com"), webapp("GitHub", "https://github.com/")], secrets: { "web:gmail": ref("s-g") }, createdAt: "t", updatedAt: "t" },
];
const LIB = { templates: TEMPLATES, customizations: CUSTOMIZATIONS };

// Template chains: Dev, then Game Dev on it, then Game Music on that; one
// whose parent is gone, two that loop.
const CHAINED: Template[] = [
  T("gamedev", ["wadbrowser", "vscode", "tiled", "libresprite"], { name: "Game Dev", parent: "dev" }),
  T("music", ["wadbrowser", "vscode", "tiled", "libresprite", "lmms"], { name: "Game Music", parent: "gamedev" }),
  T("orphan", ["krita", "obs"], { parent: "gone-for-good" }),
  T("looped", ["krita"], { parent: "loop2" }),
  T("loop2", ["krita", "obs"], { parent: "looped" }),
];
const LIB3 = { templates: [...TEMPLATES, ...CHAINED], extensions: CUSTOMIZATIONS };
const S3 = (id: string, extra: Partial<WadspaceV3>): WadspaceV3 => ({ version: 3, id, owner: "me", order: 1, createdAt: "2026-07-01", updatedAt: "2026-07-01", ...extra });
const STACKS: WadspaceV3[] = [
  S3("work3", {
    template: "dev",
    extensions: "dev-plus",
    customization: {
      name: "Work",
      description: "Day job",
      wallpaper: { type: "gradient", value: "radial-gradient(60% 70% at 18% 28%, rgb(255 61 129 / 0.5), transparent 65%), #0e0919" },
      projects: [
        { id: "web", kind: "github", repo: "HungGod/web", as: "Web", setup: "npm ci" },
        { id: "c1", kind: "copy", source: { machineId: "m1", paths: ["/var/home/wad/Notes"] }, as: "Notes", files: 12, bytes: 34567 },
      ],
      secrets: {
        bySlot: { "app:vscode": ref("s-code", "vscode"), "ext:anthropic.claude-code": ref("s-cc", "vscode-claude-code"), "app:steam": ref("s-steam", "steam") },
        groups: [
          { id: "solo", members: ["web:github"] },
          { id: "google", members: ["browser", "web:google-cloud"], key: ref("s-g") },
          { id: "empty", members: [] },
        ],
      },
    },
  }),
  S3("chained", { template: "music", customization: { name: "Chained", description: "", wallpaper: { type: "image", value: "data:image/jpeg;base64,/9j/" }, projects: [], secrets: { bySlot: {} } } }),
  S3("wrong-base", { template: "music", extensions: "dev-plus" }),
  S3("blank", { draftTemplate: { name: "Untitled", description: "" } }),
  S3("loose", { customization: { name: "Loose", description: "", wallpaper: { type: "color", value: "#000" }, projects: [], secrets: { bySlot: {} } } }),
];
const GROUPS: (KeyGroup[] | null)[] = [
  null,
  [],
  [{ id: "empty", members: [] }],
  [
    { id: "a", members: ["web:github", "web:gone"], key: ref("s-a") },
    { id: "b", members: ["browser"] },
  ],
];
const MIGRATED_PROJECTS = [
  { id: "notes", name: "Notes", mountName: "Notes", setup: "", source: { kind: "git", url: "https://github.com/HungGod/notes" } },
  { id: "web", name: "Web app", mountName: "Web", setup: "npm ci", source: { kind: "git", url: "https://github.com/HungGod/web.git", ref: "main" } },
  { id: "here", name: "Here", mountName: "Here", setup: "make", source: { kind: "folder", machineId: "m1", machineName: "Surface", path: "/var/home/wad/Here" } },
  { id: "photos", name: "Photos", mountName: "Photos", setup: "", source: { kind: "drive", uuid: "1234-ABCD", label: "Photos", fstype: "exfat", subpath: "2026" } },
];

export function cases(): Case[] {
  const c: Case[] = [];
  const add = (fn: string, ...args: unknown[]) => c.push({ fn, args });

  // spec
  for (const s of STRINGS) add("slugify", s);
  for (const w of WADD) {
    add("quadlet", w);
    add("quadlet", w, "/srv/p", "/srv/s");
  }

  // projects
  for (const d of DRAFTS) {
    add("validateProject", d);
    add("cleanDraft", d);
    add("cleanSource", d.source);
    add("sourceLabel", d.source);
    add("sourcePath", d.source);
  }
  for (const u of URLS) {
    add("repoName", u);
    add("githubUrl", u);
    add("repoFullName", u);
    add("sameRepo", u, "https://github.com/You/notes");
  }
  for (const s of [...STRINGS, "Notes", "...", ".hidden", "a b  c", "x".repeat(70)]) add("toMountName", s);
  for (const n of ["Notes", "Web", "Photos", "gone", "Brand new", "x".repeat(70)]) add("freeMountName", PROJECTS, n);
  for (const p of ["/var/home/wad/Notes", "/var/home/wad/Notes//", "Notes", "/"]) add("baseName", p);
  add("repoToDraft", { name: "My Repo.js", url: "https://github.com/me/My Repo.js" });
  for (const [id, d] of [
    ["a", { name: "A", mountName: "A", source: { kind: "git", url: "https://github.com/x/a", ref: "dev" }, setup: "s", deleted: false, createdAt: 5, updatedAt: 6 }],
    ["b", { source: { kind: "folder", path: "/p", machineId: "m", machineName: "M" }, deleted: true, createdAt: "x", legacy: true }],
    ["c", { name: "C", source: { kind: "drive", uuid: "1234-ABCD", label: "L", fstype: "vfat", subpath: "s" } }],
    ["d", { name: "D", source: { kind: "syncthing", folderId: "x" } }],
    ["e", { source: { kind: "git", url: "https://gitlab.com/x/y" } }],
    ["f", {}],
  ] as [string, Record<string, unknown>][])
    add("toProjectDoc", id, d);
  add("reposToProjects", [
    { url: "git@github.com:me/Notes.git", dest: "Notes", postClone: " npm i " },
    { url: "https://github.com/me/notes", dest: "Again" },
    { url: "https://gitlab.com/me/x", dest: "X" },
    { url: "https://github.com/me/Other", dest: "Notes" },
    { url: "https://github.com/me/Third", dest: "" },
  ]);
  for (const u of ["https://github.com/HungGod/notes.git", "https://github.com/HungGod/web", "https://github.com/HungGod/gone", "https://github.com/x/none", ""]) {
    add("projectForRepo", PROJECTS, { url: u });
  }
  for (const d of [DRAFTS[0], { ...DRAFTS[0], source: { kind: "git" as const, url: "https://github.com/HungGod/web" } }, { name: "x", mountName: "Photos", source: DRAFTS[8].source }, { name: "x", mountName: "Nope", source: DRAFTS[8].source }]) {
    add("findProject", PROJECTS, d);
  }

  // the Builder's layers and catalog
  add("catalog");
  add("starters");
  add("signInKinds");
  add("emptySetup", "dev");
  for (const x of [...SETUPS, ...CUSTOMIZATIONS, { templateId: "dev" }, {}]) add("setupOf", x);
  add("sameSetup", CUSTOMIZATIONS[0], SETUPS[1]);
  add("sameSetup", SETUPS[0], { templateId: "dev" });
  add("sameSetup", SETUPS[0], SETUPS[1]);
  for (const x of [...STRINGS, "Google Cloud", "Odd \"$x\"", "---"]) add("webappId", x);
  for (const u of ["https://github.com", "https://mail.google.com/mail/u/0", "https://odd.example/a b", "not a url", "http://x.org:8080/a"]) add("webappIcon", u);
  for (const b of [{ kind: "template", id: "dev" }, { kind: "customization", id: "dev-plus" }]) add("imageKey", b);
  for (const k of ["template:dev", "custom:dev-plus", "bare"]) add("imageRef", k);
  for (const b of [{ kind: "template", id: "dev" }, { kind: "customization", id: "dev-plus" }, { kind: "customization", id: "old-c" }, { kind: "template", id: "nope" }, { kind: "customization", id: "nope" }])
    add("resolve", LIB, b);
  for (const t of TEMPLATES) {
    for (const st of SETUPS) {
      add("slotsFor", t, st);
      add("desktopFor", t, st, PROJECTS);
      add("startMenuFor", t, st);
      add("bootables", t, st);
      add("layoutJsonFor", t, st);
      add("importable", st, t);
      add("importInto", SETUPS[0], st, t, ["webapps", "extensions", "tools", "autostart", "browserMode"]);
    }
    add("opensFolders", t);
    add("templateDockerfile", t);
    add("templateLayer", t);
    for (const c of CUSTOMIZATIONS) {
      add("extensionsDockerfile", c, t);
      add("extensionsLayer", c, t);
    }
  }

  // template chains, and wadspaces as stacks (version 3)
  for (const [t, p] of [[CHAINED[0], TEMPLATES[1]], [CHAINED[1], CHAINED[0]], [CHAINED[2], CHAINED[1]], [CHAINED[0], null]] as [Template, Template | null][]) {
    add("templateDockerfile", t, p);
    add("templateLayer", t, p);
  }
  for (const id of ["dev", "gamedev", "music", "orphan", "looped", "nope", ""]) add("chainOf", LIB3, id);
  for (const ch of [[], [TEMPLATES[1]], [TEMPLATES[1], CHAINED[0], CHAINED[1]], [CHAINED[0]], [TEMPLATES[1], CHAINED[1]], [CHAINED[0], TEMPLATES[1]], [TEMPLATES[0], { ...CHAINED[0], parent: "writing" }]])
    add("chainOk", ch);
  for (const w of STACKS) {
    add("resolveStack", LIB3, w);
    add("stackImageKey", w);
    const r = LIB3.templates.find((t) => t.id === w.template) ?? TEMPLATES[1];
    const st = LIB3.extensions.find((e) => e.id === w.extensions && e.templateId === r.id) ?? SETUPS[0];
    add("workspaceFor", w, r, st, { tz: "Pacific/Fiji", secrets: ["github_token"] });
  }
  for (const t of [TEMPLATES[0], TEMPLATES[1], CHAINED[1]]) {
    for (const st of SETUPS) {
      add("keyItems", t, st);
      for (const g of GROUPS) add("keyGroupsOf", t, st, g);
    }
  }
  for (const w of [...WADSPACES, { ...WADSPACES[0], projects: ["here", "photos", "missing"] }, STACKS[0], { version: 1, id: "v1" }]) add("migrateV2", w, LIB, MIGRATED_PROJECTS);
  add("importInto", SETUPS[2], SETUPS[1], TEMPLATES[1], ["webapps", "autostart"]);
  add("importInto", SETUPS[1], SETUPS[1], TEMPLATES[1], ["webapps", "tools"]);
  for (const st of SETUPS) add("browserSlots", st);
  add("browserSlots", BROWSERS[0]);
  const slots = [{ key: "web:github", kind: "web", label: "GitHub (web app)", appId: "WadBrowser-GitHub", iconUrl: "" }, { key: "ext:anthropic.claude-code", kind: "vscode-claude-code", label: "Claude Code (VS Code)", appId: "VSCode-ClaudeCode", iconUrl: "" }];
  for (const n of ["VanuaAcademy", "Vanua Academy", "", "  ", "Ünï Cødé"]) {
    for (const sl of slots) {
      add("newSecretName", n, sl);
      add("defaultBrowserSecretName", n, sl);
    }
  }
  for (const [a, b] of [["web", "web"], ["wadbrowser", "web"], ["obsidian", "web"], ["steam", "steam"]]) add("fits", { kind: a }, { kind: b });
  for (const k of ["web:x", "ext:openai.chatgpt", "ext:github.copilot-chat", "ext:unknown.ext", "app:steam", "app:obsidian", "app:vscode", "nokind", "zzz:x"]) add("kindOfSlotKey", k);
  add("secretUse", WADSPACES, BROWSERS);
  for (const w of WADSPACES) {
    const r = TEMPLATES.find((t) => t.id === (w.base.kind === "template" ? w.base.id : CUSTOMIZATIONS.find((c) => c.id === w.base.id)?.templateId))!;
    const st = w.base.kind === "customization" ? CUSTOMIZATIONS.find((c) => c.id === w.base.id)! : SETUPS[0];
    add("runSummary", w, PROJECTS, [...slots, { key: "app:obsidian", kind: "obsidian", label: "Obsidian", appId: "Obsidian", iconUrl: "" }]);
    add("workspaceFor", w, r, st, { tz: "Pacific/Fiji", secrets: ["github_token"] });
    add("workspaceFor", w, r, st, {});
    add("wallpaperExt", w.wallpaper);
  }
  for (const id of ["anthropic.claude-code", "a.b.c", "nodot", "a.$(x)", ""]) add("isExtensionId", id);
  add("knownWebapps", [...SETUPS, ...CUSTOMIZATIONS], BROWSERS);
  for (const [n, e] of [["work", undefined], [" WORK ", undefined], ["work", "work"], ["new", undefined]] as [string, string?][]) add("named", n, WADSPACES, ...(e ? [e] : []));
  add("stacks", { ...LIB, wadspaces: WADSPACES });
  for (const [n, e] of [["dev", undefined], ["Dev plus", "dev-plus"], [" dev PLUS ", undefined], ["Gone", undefined], ["Fresh", undefined]] as [string, string?][]) add("nameTaken", n, LIB, ...(e ? [e] : []));

  // tar
  add("tar", [
    { path: "Dockerfile", content: "FROM x\n" },
    { path: "root/etc/wadspaces/layout.json", content: "{}\n" },
    { path: "root/usr/share/backgrounds/wallpaper.png", content: { $bytes: "iVBORw0KGgoAAAANSUhEUg==" } },
    { path: "README.md", content: "# é ✓\n" },
    { path: "a/b/c.txt", content: "x".repeat(600) },
  ]);
  add("tar", [{ path: `${"d".repeat(120)}/${"f".repeat(90)}`, content: "long" }]);
  add("tar", [{ path: "x".repeat(101), content: "too long" }]);
  add("tar", [{ path: "../escape", content: "no" }]);
  add("tar", [{ path: "/abs", content: "no" }]);
  add("tar", []);
  return c;
}
