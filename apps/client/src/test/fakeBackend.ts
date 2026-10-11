// An in-memory backend for the WadSpaces Client's tests: the Builder's
// documents, layer images that build when asked (or on `finishBuilds`),
// launches recorded instead of run, and saved sign-ins.
import type { BrowserSetup, Customization, LayerKey, Template, Wadspace } from "@core/layers";
import { customizationLayer, templateLayer } from "@core/layers";
import type { Project, ProjectDraft } from "@core/projects";
import type { WaddSecret, WaddSignIn } from "@/lib/wadd";
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
  readonly caps: Caps = { sharing: false, localBuild: true, history: false, projects: true, tailnet: false, signins: true };

  templates = new Map<string, Template>();
  customizations = new Map<string, Customization>();
  wadspaces = new Map<string, Wadspace>();
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
  async listCustomizations() {
    return [...this.customizations.values()];
  }
  async saveCustomization(c: Customization) {
    this.customizations.set(c.id, c);
    this.emit("customizations");
    return c;
  }
  async patchCustomization(id: string, patch: LayerPatch) {
    return this.patchIn(this.customizations, id, patch, "customizations");
  }
  async deleteCustomization(id: string) {
    this.customizations.delete(id);
    this.images.delete(`custom:${id}`);
    this.emit("customizations");
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
    return this.patchIn(this.wadspaces, id, patch, "wadspaces");
  }
  async deleteWadspace(id: string) {
    this.wadspaces.delete(id);
    this.emit("wadspaces");
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

  /** Every build asked for so far, done: their images built from the layers as they are. */
  finishBuilds() {
    for (const { key, lib, id } of this.pending.splice(0)) {
      const t = lib.templates.find((x) => x.id === (key.startsWith("template:") ? key.slice(9) : lib.customizations.find((c) => c.id === key.slice(7))?.templateId));
      if (!t) continue;
      const tRow = this.images.get(`template:${t.id}`) ?? this.built(`template:${t.id}`, templateLayer(t).sha, "base");
      if (key.startsWith("custom:")) {
        const c = lib.customizations.find((x) => x.id === key.slice(7))!;
        this.built(key, customizationLayer(c, t).sha, tRow.id);
      } else this.built(key, templateLayer(t).sha, "base");
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
  async listMachines(): Promise<Machine[]> {
    return [];
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
  updateSignIn = nope("updateSignIn");
  signOutSignIn = nope("signOutSignIn");
  deleteSignIn = nope("deleteSignIn");
  async listSecrets(): Promise<WaddSecret[]> {
    return [];
  }
  async githubStatus() {
    return { token: false, login: null };
  }
  async listGithubRepos() {
    return { login: null, repos: [], updatedAt: null };
  }
  createGithubRepo = nope("createGithubRepo");
  cancelLaunch = nope("cancelLaunch");
}
