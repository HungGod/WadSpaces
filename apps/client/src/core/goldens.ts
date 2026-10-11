// The golden corpus for wad-core: every core function, over inputs chosen to
// cover its branches and the awkward cases (Unicode, quoting, YAML scalars,
// env order, empty values). fixtures/core/goldens.json holds what the core
// returned for each; the Rust core (crates/wad-core) must return the same,
// byte for byte. goldens.test.ts writes and checks them.
//
// A case is a function name and its arguments as JSON. Bytes (tar archives,
// wallpapers) are {"$bytes": base64}. A function that throws gives {"err"}.
import { presets, presetWadspace } from "./presets";
import { defaultAdvanced, type Layout, type LayoutIcon, type WadspaceSpec } from "./model";
import { newSpec, type CreatorSpec, type WaddSpec } from "./spec";
import type { Project, ProjectDraft } from "./projects";
import type { BrowserSetup, Customization, Setup, Template, WadspaceV2 } from "./layers";

export interface Case {
  fn: string;
  args: unknown[];
}

const icon = (appId: string, row: number, extra: Partial<LayoutIcon> = {}): LayoutIcon => ({
  id: `${appId}-${row}`,
  appId,
  label: appId,
  iconUrl: "",
  color: "#000",
  x: 0,
  y: 0,
  cell: { col: 0, row },
  ...extra,
});

const layout = (icons: LayoutIcon[], grid = true): Layout => ({ wallpaper: { type: "color", value: "#000" }, icons, grid });

const ws = (id: string, icons: LayoutIcon[], adv: Partial<WadspaceSpec["advanced"]> = {}, extra: Partial<WadspaceSpec> = {}): WadspaceSpec => ({
  id,
  name: extra.name ?? id,
  description: "",
  layout: layout(icons),
  advanced: { ...defaultAdvanced("Pacific/Fiji"), ...adv },
  ...extra,
});

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

// Builder wadspaces: the presets' desktops are added by the test (presetWadspace).
const WADSPACES: WadspaceSpec[] = [
  ws("empty-abc123", []),
  ws("mixed-abc123", [
    icon("vscode", 0),
    icon("terminal", 1, { autostart: true }),
    icon("gimp", 2),
    icon("claude", 3),
    icon("github", 4, { launcher: "kale", label: "Git Hub" }), // from before WadBrowser: a web app
    icon("brave", 5),
    icon("vscode", 6), // twice: one install
    icon("custom-thing", 7, { label: "My Site", url: "https://example.com/app?x=1" }),
    icon("custom-fav", 8, { label: "Fav", iconUrl: "https://www.google.com/s2/favicons?domain=docs.rs&sz=128" }),
    icon("nowhere", 9, { label: "Nowhere" }),
    icon("chrome", 10),
    icon("wadbrowser", 11),
    icon("spotify", 12), // a Chrome web app (DRM)
    icon("custom-up", 13, { label: "Uploaded", url: "https://up.example", iconUrl: "data:image/png;base64,iVBORw0KGgo=" }),
    icon("custom-pic", 14, { label: "Picture", url: "https://pic.example", iconUrl: "https://pic.example/me.png" }),
  ]),
  ws("browse-abc123", [icon("wadbrowser-focus", 0), icon("discord", 1), icon("gmail", 2)]),
  ws(
    "free-abc123",
    [icon("obsidian", 0, { x: 0.5, y: 0.2, cell: undefined }), icon("firefox", 0, { x: 0.1, y: 0.9, cell: undefined }), icon("krita", 0, { x: 0.1, y: 0.1, cell: undefined })],
    { display: "stream", port: 3170, hotkey: 7, image: "ghcr.io/me/free:1", persistConfig: false, devices: [], secrets: [], shmSize: "", autostart: true },
    { name: "Free “Layout” — ünïcødé $HOME `x` \\ \"q\"" },
  ),
  ws("tools-abc123", [icon("piskel", 0, { launcher: "kale" }), icon("spritesheet-packer", 1, { launcher: "kale" })], {
    tools: ["python", "cpp", "git", "hplip"],
    projects: ["notes", "gone", "missing", "photos"],
    kaleResources: [{ app_name: "Claude", app_url: "https://claude.ai" }, { app_name: "Piskel", app_url: "https://www.piskelapp.com/" }],
    env: { TZ: "Europe/Paris", ZED: "last", A: "first", QUOTE: 'say "hi"', EMPTY: "" },
    secrets: ["github_token", "openrouter_key"],
  }),
  { ...ws("files-abc123", [icon("vscode", 0)]), layout: { ...layout([icon("vscode", 0), { ...icon("x", 1), kind: "file" } as LayoutIcon]) } },
];

const BUILD_OPTS = [
  {},
  { imagePrefix: "ghcr.io/hunggod/wadspaces-" },
  { image: "localhost/explicit:2", baseImage: "localhost/other-base:1", wallpaperFile: "wallpaper.jpg", projects: PROJECTS },
  { projects: PROJECTS, wallpaperFile: "wallpaper.png" },
];

const CREATOR: CreatorSpec[] = [
  newSpec(),
  newSpec({ id: "x", name: "X" }),
  newSpec({ id: "stream-1", name: "Stream 1", display: "stream", port: 3200, hotkey: 3, autostart: true }),
  newSpec({
    id: "odd",
    name: 'Odd "name" with $vars and `ticks` \\ ünï',
    features: ["obsidian", "git", "chrome"],
    webapps: [
      { name: "Mail", url: "https://mail.google.com" },
      { id: "slack", name: "Slack \"work\"", url: "https://app.slack.com/client", chrome: true },
      { id: "mine", name: "Mine", url: "https://mine.example", iconUrl: "data:image/png;base64,iVBORw0KGgo=" },
    ],
    defaultBrowser: "full",
    aptApps: [{ id: "gimp", packages: ["gimp"], desktop: "gimp.desktop" }, { id: "ardour", packages: ["ardour", "ardour-data"] }],
    wallpaper: { fileName: "wallpaper.jpg", mode: "tile", color: "#123456" },
    layout: [{ app: "vscode", desktop: "code.desktop", label: "Code", autostart: true }, { app: "gimp", label: "GIMP" }],
    projects: [{ id: "p1", name: "Notes", mount: "Notes" }, { id: "p2", name: "Web app", mount: "Web" }],
    env: { TZ: "Pacific/Fiji", PUID: "1000", PGID: "1000", "WEIRD-KEY": "yes", NUM: "1234", BOOL: "true" },
    secrets: [],
    devices: ["/dev/dri", "/dev/kvm"],
    shmSize: "2g",
    persistConfig: false,
  }),
  newSpec({ id: "plain", name: "Plain", env: {}, secrets: [], devices: [], shmSize: "", persistConfig: false, features: [] }),
  newSpec({ id: "wall", name: "Wall", wallpaper: { fileName: "wallpaper.png", mode: "center", color: "#0b0b14" } }),
  newSpec({ id: "Bad ID", name: " ", image: " ", display: "stream", port: 8080, hotkey: 12, webapps: [{ name: "x", url: "not a url" }, { name: "y", url: "" }] }),
  newSpec({ id: "lowport", name: "Low", display: "stream", port: 80, hotkey: 0 }),
  ...presets(),
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
const ref = (id: string, kind = "web") => ({ id, name: `${id}-name`, kind }) as WadspaceV2["secrets"][string];
const W2 = (id: string, base: WadspaceV2["base"], extra: Partial<WadspaceV2> = {}): WadspaceV2 => ({
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
const V2: WadspaceV2[] = [
  W2("novel", { kind: "template", id: "writing" }, { secrets: { "app:obsidian": ref("s-obs", "obsidian") }, wallpaper: { type: "image", value: "data:image/jpeg;base64,/9j/" } }),
  W2("work", { kind: "customization", id: "dev-plus" }, {
    secrets: { "web:github": ref("s-gh"), "web:google-cloud": ref("s-g"), "ext:anthropic.claude-code": ref("s-cc", "vscode-claude-code") },
    createdAt: "2026-04-01",
  }),
  W2("legacy", { kind: "template", id: "old" }, { legacyImage: "localhost/wadspaces-legacy:latest", name: "Line\nbreak" }),
  W2("trashed", { kind: "template", id: "dev" }, { deletedAt: "2026-06-01" }),
];
const BROWSERS: BrowserSetup[] = [
  { id: "mail", owner: "me", name: "Mail", mode: "focus", webapps: [webapp("Gmail", "https://mail.google.com"), webapp("GitHub", "https://github.com/")], secrets: { "web:gmail": ref("s-g") }, createdAt: "t", updatedAt: "t" },
];
const LIB = { templates: TEMPLATES, customizations: CUSTOMIZATIONS };

export function cases(): Case[] {
  const c: Case[] = [];
  const add = (fn: string, ...args: unknown[]) => c.push({ fn, args });

  // model
  for (const tz of [undefined, "Pacific/Fiji"]) add("defaultAdvanced", ...(tz ? [tz] : []));
  for (const s of STRINGS) add("newWadspaceId", s, [0, 0.5, 0.999, 0.1, 0.25, 0.75]);
  for (const w of WADSPACES) {
    add("dropFileIcons", w.layout);
    add("orderedIcons", w.layout);
    add("orderedIcons", { ...w.layout, grid: false });
  }

  // spec
  for (const s of STRINGS) add("slugify", s);
  for (const p of [{}, { id: "x", display: "stream" as const }, { id: "y", name: "Y", features: [] as never[], env: {} }]) add("newSpec", p);
  for (const s of CREATOR) {
    add("resolveFeatures", s);
    add("volumesFor", s);
    add("toWaddSpec", s);
    add("validate", s);
    add("dockerfile", s);
    add("compose", s);
    add("readme", s);
    add("wadbrowserConf", s);
    add("layoutJson", s);
    add("bundleFiles", s);
    add("bundleFiles", s, { $bytes: "iVBORw0KGgo=" }, "FROM scratch\n");
  }
  // Web apps' icons, made by wadd: only the spec's own web apps, by a valid id.
  add("bundleFiles", CREATOR[3], null, null, { slack: { $bytes: "iVBORw0KGgo=" }, mine: { $bytes: "AAEC" }, other: { $bytes: "AA==" }, "Bad Id": { $bytes: "AA==" } });
  for (const w of WADD) {
    add("quadlet", w);
    add("quadlet", w, "/srv/p", "/srv/s");
    add("workspacesYamlSnippet", w);
    add("fromWaddSpec", w);
    add("fromWaddSpec", w, CREATOR[3]);
  }
  add("baseImageFor", "host");
  add("baseImageFor", "stream");

  // build
  for (const w of WADSPACES) for (const o of BUILD_OPTS) add("toBuildSpec", w, o);
  for (const p of presets()) add("toBuildSpec", presetWadspace(p.id), { projects: PROJECTS });

  // recipes and icons
  for (const [id, d] of [["vscode"], ["brave"], ["unknown-app"], ["unknown-app", "example.com"], ["unknown-app", "http://x.org/a"], ["claude", "ignored.com"], ["wadbrowser"], ["wadbrowser-focus"], ["spotify"], ["zoom"]] as [string, string?][]) {
    add("recipeFor", id, ...(d ? [d] : []));
  }
  for (const u of [
    "https://www.google.com/s2/favicons?domain=code.visualstudio.com&sz=128",
    "https://www.google.com/s2/favicons?sz=64&domain=firefox.com",
    "https://www.google.com/s2/favicons?domain=unknown.example",
    "https://www.google.com/s2/favicons",
    "/catalog/chrome.png",
    "https://example.com/icon.png",
  ])
    add("localIcon", u);

  // presets
  for (const id of ["writing", "iq-dev", "wad-c", "kale-b", "vanua-academy", "kale-p", "nope"]) {
    add("presetWadspace", id);
    add("presetProjects", id);
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
      add("customizationDockerfile", c, t);
      add("customizationLayer", c, t);
    }
  }
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
  add("secretUse", V2, BROWSERS);
  for (const w of V2) {
    const r = TEMPLATES.find((t) => t.id === (w.base.kind === "template" ? w.base.id : CUSTOMIZATIONS.find((c) => c.id === w.base.id)?.templateId))!;
    const st = w.base.kind === "customization" ? CUSTOMIZATIONS.find((c) => c.id === w.base.id)! : SETUPS[0];
    add("runSummary", w, PROJECTS, [...slots, { key: "app:obsidian", kind: "obsidian", label: "Obsidian", appId: "Obsidian", iconUrl: "" }]);
    add("workspaceFor", w, r, st, { tz: "Pacific/Fiji", secrets: ["github_token"] });
    add("workspaceFor", w, r, st, {});
    add("wallpaperExt", w.wallpaper);
  }
  for (const id of ["anthropic.claude-code", "a.b.c", "nodot", "a.$(x)", ""]) add("isExtensionId", id);
  add("knownWebapps", [...SETUPS, ...CUSTOMIZATIONS], BROWSERS);
  for (const [n, e] of [["work", undefined], [" WORK ", undefined], ["work", "work"], ["new", undefined]] as [string, string?][]) add("named", n, V2, ...(e ? [e] : []));
  add("stacks", { ...LIB, wadspaces: V2 });
  for (const [n, e] of [["dev", undefined], ["Dev plus", "dev-plus"], [" dev PLUS ", undefined], ["Gone", undefined], ["Fresh", undefined]] as [string, string?][]) add("nameTaken", n, LIB, ...(e ? [e] : []));
  const signins = [{ id: "s-obs", name: "Notes", app: "obsidian" }, { id: "s-web", name: "Google", app: "web" }];
  const opts = { owner: "me", now: "2026-10-11T00:00:00.000Z", signins, legacyImage: null };
  for (const w of WADSPACES) {
    add("migrateWadspaceV1", w, LIB, opts);
    add("migrateWadspaceV1", w, { templates: [], customizations: [] }, { ...opts, legacyImage: `localhost/wadspaces-${w.id}:latest`, projects: ["notes"] });
  }
  for (const p of presets()) add("migrateWadspaceV1", presetWadspace(p.id), LIB, opts);
  add("migrateWadspaceV1", { id: "x", name: "", description: "" }, LIB, opts);

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
