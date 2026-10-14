// An in-memory backend for the WadSpaces Client's tests: the Builder's
// documents, layer images that build when asked (or on `finishBuilds`),
// stacks installed and copies made on "the machine", launches recorded
// instead of run, and saved sign-ins.
import type { BrowserSetup, Extensions, LayerKey, Template, Wadspace } from "@core/layers";
import { chainOf, extensionsLayer, templateLayer } from "@core/layers";
import type { StoredWadspace } from "@/data/migrate";
import type { GithubRepo, Project, ProjectDraft } from "@core/projects";
import type { DiskPick, OtherPart, WaddSecret, WaddSignIn } from "@/lib/wadd";
import type { ContainerRun, FocusLock, LastSession, Machine, PublicUser } from "@/lib/types";
import type { Backend, BuildProgress, Caps, LayerLibrary, LayerPatch, Topic } from "@/data/backend";
import type { ImageRow, RunItem } from "@/data/layers";
import { STARTERS } from "@core/catalog/catalog";

const nope = (what: string) => () => Promise.reject(new Error(`${what} isn't in the fake backend`));

/** A launch the fake recorded. */
export interface FakeLaunch {
  items: RunItem[];
  focusMinutes: number | null;
}

export class FakeBackend implements Backend {
  readonly target: "offline" | "online" | "machine";
  readonly caps: Caps = { sharing: false, localBuild: true, history: false, projects: true, copies: true, tailnet: false, signins: true };

  templates = new Map<string, Template>();
  extensions = new Map<string, Extensions>();
  /** Extensions layers from before they had that name. */
  customizations = new Map<string, Extensions>();
  wadspaces = new Map<string, StoredWadspace>();
  /** Stacks installed on "the machine", as they were then. */
  installed = new Map<string, Wadspace>();
  /** Copies made on "the machine": their paths. */
  copies = new Map<string, string[]>();
  /** Your GitHub repositories, as a machine lists them. */
  repos: GithubRepo[] = [];
  /** The machine's folders you can copy from: folder → its folders and files. */
  folders: Record<string, { dirs: string[]; files: string[] }> = {};
  browsers = new Map<string, BrowserSetup>();
  images = new Map<LayerKey, ImageRow>();
  /** Layer builds asked for, oldest first. */
  builds: LayerKey[] = [];
  launches: FakeLaunch[] = [];
  signIns: WaddSignIn[] = [];
  projects: Project[] = [];
  startersCreated = false;
  screen = { width: 1920, height: 1080 };
  private listeners = new Set<(t: Topic) => void>();
  private buildListeners = new Set<(b: BuildProgress) => void>();
  private seq = 0;

  constructor(opts: { target?: "offline" | "online" | "machine" } = {}) {
    this.target = opts.target ?? "offline";
  }

  private emit(t: Topic) {
    this.listeners.forEach((fn) => fn(t));
  }

  subscribe(fn: (t: Topic) => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  // ------------------------------------------------------------- layers
  async listTemplates() {
    return [...this.templates.values()];
  }
  async saveTemplate(t: Template) {
    this.templates.set(t.id, t);
    this.emit("templates");
    return t;
  }
  async patchTemplate(id: string, patch: LayerPatch) {
    return this.patchIn(this.templates, id, patch, "templates");
  }
  async deleteTemplate(id: string) {
    this.templates.delete(id);
    this.images.delete(`template:${id}`);
    this.emit("templates");
  }
  async listExtensions() {
    return [...this.extensions.values()];
  }
  async saveExtensions(e: Extensions) {
    this.extensions.set(e.id, e);
    this.emit("extensions");
    return e;
  }
  async patchExtensions(id: string, patch: LayerPatch) {
    return this.patchIn(this.extensions, id, patch, "extensions");
  }
  async deleteExtensions(id: string) {
    this.extensions.delete(id);
    this.images.delete(`custom:${id}`);
    this.emit("extensions");
  }
  async listOldCustomizations() {
    return [...this.customizations.values()];
  }
  async deleteOldCustomization(id: string) {
    this.customizations.delete(id);
  }
  async listWadspaces() {
    return [...this.wadspaces.values()];
  }
  async saveWadspace(w: Wadspace) {
    this.wadspaces.set(w.id, w);
    this.emit("wadspaces");
    return w;
  }
  async patchWadspace(id: string, patch: LayerPatch) {
    if (patch.deletedAt) this.installed.delete(id);
    return this.patchIn(this.wadspaces, id, patch, "wadspaces") as Wadspace;
  }
  async deleteWadspace(id: string) {
    this.wadspaces.delete(id);
    this.installed.delete(id);
    this.emit("wadspaces");
  }
  async installWadspace(w: Wadspace) {
    if (!w.template || !w.customization?.name.trim()) throw new Error("It needs a template and a named customization.");
    this.installed.set(w.id, w);
  }
  async makeCopy(paths: string[]) {
    const id = `copy-${++this.seq}`;
    this.copies.set(id, paths);
    return { id, files: paths.length, bytes: 100 * paths.length };
  }
  /** What WadSpaces takes on the disk: the base, each built layer's own share, each home (bytes set in `sizes`). */
  sizes: {
    base: number;
    layers: Record<string, number>;
    leftovers: { layer: string; id: string; from: string; bytes: number; ownBytes: number }[];
    other: OtherPart[];
    homes: Record<string, number>;
    copies: Record<string, number>;
    disk: { total: number; free: number };
  } = {
    base: 3.1e9,
    leftovers: [],
    other: [],
    layers: {},
    homes: {},
    copies: {},
    disk: { total: 120e9, free: 48e9 },
  };
  async storage() {
    const z = this.sizes;
    return {
      disk: { path: "/var/lib/containers", totalBytes: z.disk.total, freeBytes: z.disk.free },
      base: { ref: "localhost/wadspaces-base:trixie", id: "base", bytes: z.base },
      layers: [...this.images.values()].filter((r) => r.layer !== ("base" as string)).map((r) => ({ layer: r.layer, id: r.id, from: r.from, bytes: 0, ownBytes: z.layers[r.layer] ?? r.sizeMb * 1e6 })),
      leftovers: z.leftovers,
      other: z.other,
      homes: [...this.installed.keys()].map((id) => ({ workspaceId: id, volume: `wad-${id}-config`, bytes: z.homes[id] ?? 0 })),
      copies: Object.entries(z.copies).map(([id, bytes]) => ({ id, bytes })),
      measuredAt: Date.now() / 1000,
    };
  }
  /** Picked off "the machine's" disk: as wadd does, refusing a running wadspace. */
  deleted: DiskPick[] = [];
  async deleteFromDisk(pick: DiskPick) {
    const running = pick.wadspaces.find((id) => this.running.has(id));
    if (running) throw new Error(`${running} is running: stop it first`);
    this.deleted.push(pick);
    let bytes = 0;
    for (const id of pick.wadspaces) (this.installed.delete(id), (bytes += this.sizes.homes[id] ?? 0));
    for (const l of pick.layers) (this.images.delete(l as LayerKey), (bytes += this.sizes.layers[l] ?? 0));
    // Other images, homes left behind, the update copy: out of the report.
    const gone = new Set([...(pick.images ?? []), ...(pick.volumes ?? [])]);
    this.sizes = {
      ...this.sizes,
      other: this.sizes.other
        .filter((p) => !(p.key === "update-copy" && pick.updateCopy))
        .map((p) => ({ ...p, items: p.items.filter((i) => !gone.has(i.id) || ((bytes += i.bytes), false)) })),
    };
    this.emit("images");
    this.emit("machines");
    return { removed: pick.layers, kept: [], uninstalled: pick.wadspaces, bytes };
  }
  /** Files on "the machine": path ("root/dir/name") → text (a folder: null). */
  fileTree: Record<string, string | null> = {};
  readonly files = {
    roots: async () => [{ id: "home", label: "Your files", detail: "On the machine itself." }],
    list: async (root: string, path: string) => {
      const at = [root, path].filter(Boolean).join("/");
      const names = new Map<string, boolean>();
      for (const [p, v] of Object.entries(this.fileTree)) {
        if (!p.startsWith(`${at}/`)) continue;
        const rest = p.slice(at.length + 1).split("/");
        names.set(rest[0], rest.length > 1 || v === null || names.get(rest[0]) === true);
      }
      return {
        root,
        path,
        entries: [...names].map(([name, dir]) => ({ name, dir, bytes: dir ? 0 : (this.fileTree[`${at}/${name}`] ?? "").length, modified: 0, text: !dir })).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)),
      };
    },
    readText: async (root: string, path: string) => this.fileTree[`${root}/${path}`] ?? "",
    writeText: async (root: string, path: string, text: string) => void (this.fileTree[`${root}/${path}`] = text),
    delete: async (root: string, path: string) => {
      const at = `${root}/${path}`;
      for (const p of Object.keys(this.fileTree)) if (p === at || p.startsWith(`${at}/`)) delete this.fileTree[p];
    },
  };
  async pruneOld() {
    const removed = this.sizes.leftovers.map((l) => l.id);
    const bytes = this.sizes.leftovers.reduce((n, l) => n + l.ownBytes, 0);
    this.sizes = { ...this.sizes, leftovers: [] };
    return { removed, kept: [], uninstalled: [], bytes };
  }
  async deleteCopy(id: string) {
    this.copies.delete(id);
  }
  async listBrowsers() {
    return [...this.browsers.values()];
  }
  async saveBrowser(b: BrowserSetup) {
    this.browsers.set(b.id, b);
    this.emit("browsers");
    return b;
  }
  async patchBrowser(id: string, patch: LayerPatch) {
    return this.patchIn(this.browsers, id, patch, "browsers");
  }
  async deleteBrowser(id: string) {
    this.browsers.delete(id);
    this.emit("browsers");
  }

  private patchIn<T extends { id: string }>(m: Map<string, T>, id: string, patch: LayerPatch, topic: Topic): T {
    const cur = m.get(id);
    if (!cur) throw new Error("It's gone.");
    const next = { ...cur, ...patch } as T & LayerPatch;
    if (next.deletedAt === null) delete next.deletedAt;
    m.set(id, next);
    this.emit(topic);
    return next;
  }

  async listImages() {
    return [...this.images.values()];
  }

  /** A build that's asked for finishes when `finishBuilds` is called. */
  private pending: { key: LayerKey; lib: LayerLibrary; id: string }[] = [];
  async buildLayer(key: LayerKey, lib: LayerLibrary) {
    const id = `b${++this.seq}`;
    this.builds.push(key);
    this.pending.push({ key, lib, id });
    this.buildListeners.forEach((fn) => fn({ id, wadspaceId: key, name: key, status: "building", progress: 0, from: 0, lines: [], layer: key }));
    return id;
  }

  /** Every build asked for so far, done: their images built from the layers
   *  as they are, the templates under them first (each on the one below). */
  finishBuilds() {
    for (const { key, lib, id } of this.pending.splice(0)) {
      const e = key.startsWith("custom:") ? lib.extensions.find((c) => c.id === key.slice(7)) : undefined;
      const chain = chainOf(lib, key.startsWith("template:") ? key.slice(9) : (e?.templateId ?? ""));
      if (!chain.length) continue;
      let from = "base";
      chain.forEach((t, i) => {
        from = this.built(`template:${t.id}`, templateLayer(t, chain[i - 1] ?? null).sha, from).id;
      });
      if (e) this.built(key, extensionsLayer(e, chain[chain.length - 1]).sha, from);
      this.buildListeners.forEach((fn) => fn({ id, wadspaceId: key, name: key, status: "done", progress: 1, from: 0, lines: [], layer: key }));
    }
    this.emit("images");
  }

  private built(key: LayerKey, sha: string, from: string): ImageRow {
    const row: ImageRow = { layer: key, ref: key, id: `img${++this.seq}`, dockerfileSha: sha, builtAt: Date.now() / 1000, sizeMb: 1500, from };
    this.images.set(key, row);
    return row;
  }

  onBuild(fn: (b: BuildProgress) => void) {
    this.buildListeners.add(fn);
    return () => void this.buildListeners.delete(fn);
  }

  async deleteImage(key: LayerKey) {
    this.images.delete(key);
  }
  async launchItems(items: RunItem[], focusMinutes: number | null) {
    this.launches.push({ items, focusMinutes });
    return items.map((i) => (i.kind === "wadspace" ? (i.overrides ? `run-${i.wadspaceId}` : i.wadspaceId) : i.kind === "browser" ? `browser-${i.savedId ?? "run"}` : "terminal"));
  }
  async machineScreen() {
    return this.screen;
  }
  owner() {
    return "me";
  }
  async createStarters() {
    if (this.startersCreated) return [];
    this.startersCreated = true;
    const made: Template[] = [];
    for (const s of STARTERS) {
      if (this.templates.has(s.id)) continue;
      const t: Template = { ...s, owner: "me", starter: true, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
      this.templates.set(t.id, t);
      made.push(t);
    }
    return made;
  }

  // --------------------------------------------------- the rest of the app
  defaultMachineId() {
    return "this-machine";
  }
  async me(): Promise<PublicUser> {
    return { username: "me", displayName: "Me", color: "#c6ff1f", onboarded: true };
  }
  async signOut() {}
  async setOnboarded() {}
  async users() {
    return [await this.me()];
  }
  /** Stopping a build (a test sets it to watch). */
  cancelBuild?: (id: string) => Promise<void>;
  /** "This machine", with the stacks installed (and `running`); off unless asked for (dev:fake). */
  thisMachine = false;
  running = new Set<string>();
  async listMachines(): Promise<Machine[]> {
    if (!this.thisMachine) return [];
    const containers = [...this.installed.keys()].map((id) => ({
      id,
      wadspaceId: id,
      status: this.running.has(id) ? ("running" as const) : ("stopped" as const),
      mode: "local" as const,
      startedAt: new Date(0).toISOString(),
      native: true,
    }));
    return [{ id: "this-machine", name: "surface", label: "This machine", os: "WadSpaces · wadd 0.1.0", status: "online", linked: true, cpu: 14, ram: 38, gpu: "Intel HD 620", ip: "127.0.0.1", containers }];
  }
  container = nope("container");
  async getFocus(): Promise<{ focus: FocusLock | null; now: number }> {
    return { focus: null, now: Date.now() };
  }
  async lastSession(): Promise<LastSession | null> {
    return null;
  }
  async runs(): Promise<ContainerRun[]> {
    return [];
  }
  uploadImage = nope("uploadImage");
  async listProjects() {
    return this.projects;
  }
  async saveProject(p: ProjectDraft) {
    const project = { ...p, id: p.id ?? `p${++this.seq}`, deleted: false, createdAt: 0, updatedAt: 0, setup: p.setup ?? "" } as Project;
    this.projects.push(project);
    this.emit("projects");
    return project;
  }
  deleteProject = nope("deleteProject");
  async projectStatus() {
    return null;
  }
  async listSignIns() {
    return this.signIns;
  }
  async createSignIn(input: { name: string; app: string }) {
    if (this.signIns.some((s) => s.name.toLowerCase() === input.name.toLowerCase())) throw new Error(`there's a sign-in called ${input.name} already`);
    const s: WaddSignIn = { id: `s${++this.seq}`, name: input.name, app: input.app, paths: [], createdAt: 0, size: 0, changedAt: null, usedBy: [], inUse: [] };
    this.signIns.push(s);
    this.emit("signins");
    return s;
  }
  async updateSignIn(id: string, patch: { name?: string; paths?: string[] }) {
    const s = this.signIns.find((x) => x.id === id);
    if (!s) throw new Error(`no sign-in ${id}`);
    if (patch.name && this.signIns.some((x) => x.id !== id && x.name.toLowerCase() === patch.name!.toLowerCase())) throw new Error(`there's a sign-in called ${patch.name} already`);
    Object.assign(s, patch);
    this.emit("signins");
    return s;
  }
  signOutSignIn = nope("signOutSignIn");
  deleteSignIn = nope("deleteSignIn");
  async listSecrets(): Promise<WaddSecret[]> {
    return [];
  }
  async githubStatus() {
    return { token: false, login: null };
  }
  async listGithubRepos() {
    return { login: this.repos.length ? "me" : null, repos: this.repos, updatedAt: null };
  }
  async browseFolders(q: { path?: string; files?: boolean }) {
    const at = q.path ?? null;
    const name = (x: string) => x.split("/").pop()!;
    if (!at) return { path: null, parent: null, dirs: Object.keys(this.folders).filter((f) => !Object.values(this.folders).some((v) => v.dirs.includes(f))).map((f) => ({ name: f, path: f })) };
    const here = this.folders[at];
    if (!here) throw new Error(`${at} isn't there`);
    const parent = Object.entries(this.folders).find(([, v]) => v.dirs.includes(at))?.[0] ?? null;
    return { path: at, parent, dirs: here.dirs.map((d) => ({ name: name(d), path: d })), ...(q.files && { files: here.files.map((f) => ({ name: name(f), path: f })) }) };
  }
  createGithubRepo = nope("createGithubRepo");
  cancelLaunch = nope("cancelLaunch");
}

/** "Everything else" as a machine after a few stick updates has it (dev:fake). */
export const SAMPLE_OTHER: OtherPart[] = [
  { key: "system", label: "The WadSpaces system", detail: "The system itself: 2 versions kept, this one and the one before it (to go back to). It stays.", bytes: 7.8e9, items: [], deletable: false },
  { key: "update-copy", label: "The last stick update's copy", detail: "What the last stick update copied in, already applied: nothing needs it.", bytes: 4.8e9, items: [], deletable: true },
  {
    key: "images",
    label: "Other images",
    detail: "Images the wadspaces' layers don't count: older bases, images from before layers, steps builds left.",
    bytes: 9.4e9,
    items: [
      { id: "aa11", label: "vanua-academy", detail: "From before the Builder's layers: nothing uses it.", bytes: 4.1e9, deletable: true },
      { id: "bb22", label: "kale-b", detail: "From before the Builder's layers: nothing uses it.", bytes: 3.2e9, deletable: true },
      { id: "cc33", label: "An older base", detail: "Templates built before the last base update still stand on it: update them, and it can go.", bytes: 1.6e9, deletable: true },
      { id: "dd44", label: "A build step", detail: "Left by a build; nothing names it.", bytes: 0.5e9, deletable: true },
    ],
    deletable: false,
  },
  { key: "shared", label: "Shared by older images", detail: "Image layers older images still hold in common, such as an older base that templates built before the last base update still stand on. Update those templates and it goes.", bytes: 3.1e9, items: [], deletable: false },
  {
    key: "volumes",
    label: "Homes left behind",
    detail: "Files of wadspaces no longer on this machine (built again, a wadspace with the same id gets its home back).",
    bytes: 2.3e9,
    items: [
      { id: "wad-iq-dev-config", label: "iq-dev's home", detail: "A home whose wadspace isn't on this machine any more.", bytes: 1.9e9, deletable: true },
      { id: "wad-kale-p-config", label: "kale-p's home", detail: "A home whose wadspace isn't on this machine any more.", bytes: 0.4e9, deletable: true },
    ],
    deletable: false,
  },
  { key: "logs", label: "Logs", detail: "The system's logs (/var/log), kept and trimmed by the system.", bytes: 0.36e9, items: [], deletable: false },
  { key: "wadd", label: "WadSpaces' own files", detail: "wadd's records: build and launch logs, web apps' icons, saved sign-ins.", bytes: 0.002e9, items: [], deletable: false },
  { key: "people", label: "Your files", detail: "Your files on the machine (/var/home): WadBrowser's downloads and profiles, the WadSpaces app's data.", bytes: 0.03e9, items: [], deletable: false },
  { key: "unaccounted", label: "Not listed above", detail: "The disk's own bookkeeping, and files outside the folders above.", bytes: 1.2e9, items: [], deletable: false },
];
