// The offline backend: this machine, through wadd.
//
// wadd's server-sent events give a live snapshot of every workspace (and of
// builds); the Builder library and drafts are kept by wadd (library.ts). A
// wadspace here is a library entry, an installed workspace, or both: installed
// workspaces without a library copy (the presets on the stick, or ones added
// by hand) show their preset desktop or a plain one.
//
// Projects are wadd's too (/api/projects): it keeps them, syncs them with the
// account when the machine is linked, clones them from GitHub with the
// machine's github_token (/api/github) and mounts the clones when it launches
// a wadspace (/api/launches). Tailscale is wadd's as well (/api/tailnet).
import catalog from "@core-data/apps.json";
import { defaultAdvanced, type WadspaceSpec } from "@core/model";
import { cleanDraft, toProjectDoc, type Project, type ProjectDraft } from "@core/projects";
import { presetProjects, presetWadspace } from "@core/presets";
import { type WaddSpec } from "@core/spec";
import { imageDataUrl } from "@/lib/images";
import { THIS_MACHINE } from "@/lib/machine";
import type { App, Container, ContainerRun, Machine, PublicUser, TailnetStatus, Wadspace } from "@/lib/types";
import {
  waddEvents,
  WaddError,
  downloadLabel,
  wadd,
  type BuildUpdate,
  type LaunchUpdate,
  type MachineWorkspace,
  type Metrics,
  type Snapshot,
  type WaddProject,
} from "@/lib/wadd";
import {
  Unsupported,
  type Backend,
  type BuildProgress,
  type Caps,
  type ContainerAction,
  type GithubRepoList,
  type LaunchProgress,
  type NewRepo,
  type Topic,
} from "../backend";
import { ensureProjects, hasRepos, knownProjectIds, migrateRepos, withProjects } from "../projects";
import { toLaunchProgress, toProgress } from "./builds";
import { LocalLibrary } from "./library";
import { lastSession, onboarded, presetProjectsMade } from "./store";
import { WaddLayerDocs, WaddMachine } from "./layers";
import type { BrowserSetup, Customization, LayerKey, Template, WadspaceV2 } from "@core/layers";
import type { LayerLibrary, LayerPatch } from "../backend";
import type { RunItem } from "../layers";

export { THIS_MACHINE };
const LOCAL_USER = "local";
const PLAIN_WALLPAPER = "radial-gradient(90% 70% at 80% 10%, #ff3d8155 0%, transparent 60%), radial-gradient(70% 60% at 10% 90%, #5b2bff44 0%, transparent 60%), #0a0614";
const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "Etc/UTC";
const iso = (t: number | null) => (t == null ? null : new Date(t * 1000).toISOString());

/** wadd's project document, minus what only wadd needs (it keeps `legacy`:
 *  a folder from before projects were GitHub repos). */
function toProject(p: WaddProject): Project {
  return toProjectDoc(p.id, p as unknown as Record<string, unknown>, (t) => (typeof t === "number" ? t : 0));
}

/** A workspace wadd runs that nobody designed in the Builder. */
function fromInstalled(w: WaddSpec): WadspaceSpec {
  return {
    id: w.id,
    name: w.name,
    description: "",
    layout: { wallpaper: { type: "gradient", value: PLAIN_WALLPAPER }, icons: [], grid: true },
    advanced: {
      ...defaultAdvanced(w.env?.TZ ?? tz()),
      display: w.display ?? "stream",
      port: w.port ?? null,
      hotkey: w.hotkey ?? null,
      tools: [],
      env: w.env ?? {},
      secrets: w.secrets ?? [],
      devices: w.devices ?? [],
      shmSize: w.shm_size ?? "1g",
      persistConfig: (w.volumes ?? []).some((v) => v.startsWith(`wad-${w.id}-config:/config`)),
      autostart: !!w.autostart,
      image: w.image,
    },
  };
}

export class LocalBackend implements Backend {
  readonly target = "offline" as const;
  readonly caps: Caps = {
    sharing: false,
    localBuild: false, // set by init() when this wadd can build
    history: false, // set by init() when this wadd keeps run history
    projects: false, // set by init() when this wadd has projects
    tailnet: false, // set by init() when Tailscale is installed here
    signins: false, // set by init() when this wadd keeps saved sign-ins
  };

  private snap: Snapshot | null = null;
  private connected = false;
  private specs: WaddSpec[] = [];
  private specsKey = "";
  private listeners = new Set<(t: Topic) => void>();
  private buildListeners = new Set<(b: BuildProgress) => void>();
  private launchListeners = new Set<(l: LaunchProgress) => void>();
  private projects: Project[] = [];
  private firstSnap: Promise<void>;
  private gotFirstSnap!: () => void;
  private lib = new LocalLibrary();
  private metrics: Metrics | null = null;
  private metricsAt = 0;
  private tailnet: TailnetStatus | null = null;
  private tailnetAt = 0;
  private readonly seenAt = new Date().toISOString();
  /** The Builder's documents (wadd's library) and this machine's layer work. */
  readonly docs = new WaddLayerDocs(() => LOCAL_USER);
  readonly machine = new WaddMachine();

  constructor() {
    this.firstSnap = new Promise((r) => (this.gotFirstSnap = r));
    // Don't hold the UI hostage if wadd is down: show what we have after a moment.
    setTimeout(() => this.gotFirstSnap(), 2500);
    this.connect();
  }

  /** Find out what this wadd can do (an older one on a stick predates builds). */
  async init() {
    const f = await wadd.features();
    // Layer images need the Rust wadd's /v1/images: a machine without it can't build.
    this.caps.localBuild = f.builds && f.layers;
    this.caps.history = f.runs;
    this.caps.projects = f.projects;
    this.caps.signins = f.signins;
    this.tailnet = f.tailnet;
    this.tailnetAt = Date.now();
    this.caps.tailnet = !!f.tailnet?.installed;
    await this.lib.load(f.library).catch(() => this.lib.load(false));
    if (this.caps.projects) {
      await this.refreshProjects();
      // In the background: the app needn't wait for the old repos to move.
      this.migrateLibrary().catch(() => {});
    }
  }

  /** Wadspaces saved before projects: their repos become projects (before
   *  they move onto the layers, data/migrate.ts). */
  private async migrateLibrary() {
    let changed = false;
    for (const e of this.lib.entries()) {
      if (!hasRepos(e.spec.advanced)) continue;
      await this.lib.put({ ...e, spec: { ...e.spec, advanced: await migrateRepos(this, e.spec.advanced) } });
      changed = true;
    }
    if (changed) this.emit("wadspaces");
  }

  /** Drafts are gone from the Builder. wadd removes its library/drafts
   *  itself; these are the ones an older app kept in its own storage. */
  async discardDrafts() {
    const drafts = this.lib.drafts();
    for (const d of drafts) this.lib.removeDraft(d.id);
    return drafts.length;
  }

  // ---------------------------------------------------- the Builder's layers
  listTemplates() {
    return this.docs.templates.list();
  }
  saveTemplate(t: Template) {
    return this.docs.templates.put(t).then((x) => (this.emit("templates"), x));
  }
  patchTemplate(id: string, patch: LayerPatch) {
    return this.docs.templates.patch(id, patch).then((x) => (this.emit("templates"), x));
  }
  async deleteTemplate(id: string) {
    await this.machine.deleteImage(`template:${id}`);
    await this.docs.templates.remove(id);
    this.emit("templates");
    this.emit("images");
  }
  listCustomizations() {
    return this.docs.customizations.list();
  }
  saveCustomization(c: Customization) {
    return this.docs.customizations.put(c).then((x) => (this.emit("customizations"), x));
  }
  patchCustomization(id: string, patch: LayerPatch) {
    return this.docs.customizations.patch(id, patch).then((x) => (this.emit("customizations"), x));
  }
  async deleteCustomization(id: string) {
    await this.machine.deleteImage(`custom:${id}`);
    await this.docs.customizations.remove(id);
    this.emit("customizations");
    this.emit("images");
  }
  listWadspaces() {
    return this.docs.wadspaces.list();
  }
  /** Kept in the library and installed here. */
  async saveWadspace(w: WadspaceV2, lib: LayerLibrary) {
    const saved = await this.docs.wadspaces.put(w);
    await this.machine.install(saved, { ...lib, wadspaces: [...lib.wadspaces.filter((x) => x.id !== w.id), saved] });
    this.emit("wadspaces");
    return saved;
  }
  async patchWadspace(id: string, patch: LayerPatch, lib: LayerLibrary) {
    const saved = await this.docs.wadspaces.patch(id, patch);
    // Its old image gone (its layers built): it runs on them from now on.
    if ("legacyImage" in patch) await this.machine.install(saved, lib);
    this.emit("wadspaces");
    return saved;
  }
  async deleteWadspace(id: string) {
    await this.machine.uninstall(id);
    await this.docs.wadspaces.remove(id);
    this.emit("wadspaces");
  }
  listBrowsers() {
    return this.docs.browsers.list();
  }
  saveBrowser(b: BrowserSetup) {
    return this.docs.browsers.put(b).then((x) => (this.emit("browsers"), x));
  }
  patchBrowser(id: string, patch: LayerPatch) {
    return this.docs.browsers.patch(id, patch).then((x) => (this.emit("browsers"), x));
  }
  async deleteBrowser(id: string) {
    await this.docs.browsers.remove(id);
    this.emit("browsers");
  }
  listImages() {
    return this.machine.images();
  }
  buildLayer(key: LayerKey, lib: LayerLibrary) {
    return this.machine.build(key, lib);
  }
  deleteImage(key: LayerKey) {
    return this.machine.deleteImage(key);
  }
  launchItems(items: RunItem[], focusMinutes: number | null, lib: LayerLibrary) {
    return this.machine.launch(items, focusMinutes, lib);
  }
  machineScreen() {
    return this.machine.screen();
  }
  owner() {
    return LOCAL_USER;
  }
  async createStarters() {
    const made = await this.docs.createStarters();
    if (made.length) this.emit("templates");
    return made;
  }

  // ----------------------------------------------------------- live state
  private emit(t: Topic) {
    this.listeners.forEach((fn) => fn(t));
  }

  /** Something changed that wadd won't announce (the machine app set its GitHub token). */
  changed(t: Topic) {
    this.emit(t);
  }

  private connect() {
    waddEvents(
      (event, data) => {
        switch (event) {
          case "state": {
            const snap = data as Snapshot;
            this.snap = snap;
            this.connected = true;
            this.gotFirstSnap();
            this.emit("machines");
            this.emit("focus");
            // The set of installed workspaces (or whether their images are here) changed.
            const key = snap.workspaces.map((w) => `${w.id}:${w.enabled}:${w.state.image_present}:${w.image}`).join(",");
            if (key !== this.specsKey) {
              this.specsKey = key;
              this.refreshSpecs().then(() => this.emit("wadspaces"));
            }
            break;
          }
          case "build": {
            const b = toProgress(data as BuildUpdate);
            this.buildListeners.forEach((fn) => fn(b));
            // A layer's image built (or not): the Builder's states follow.
            if (b.layer && b.status !== "building") {
              this.machine.building.delete(b.layer);
              this.emit("images");
            } else if (b.layer) this.machine.building.add(b.layer);
            break;
          }
          case "launch": {
            const l = toLaunchProgress(data as LaunchUpdate);
            this.launchListeners.forEach((fn) => fn(l));
            break;
          }
          // A project changed (here, or synced from the account): presets name theirs by id.
          case "projects":
            this.refreshProjects().then(() => {
              this.emit("projects");
              this.emit("wadspaces");
            });
            break;
          // A saved sign-in was made, renamed, signed out or deleted.
          case "signins":
            this.emit("signins");
            break;
          // Tailscale's state changed (signed in, out, online): ask for the
          // whole status.
          case "tailnet":
            this.freshTailnet(true).then(() => this.emit("machines"));
            break;
        }
      },
      () => {
        if (this.connected) {
          this.connected = false;
          this.emit("machines");
        }
      },
    );
  }

  private async refreshProjects() {
    if (!this.caps.projects) return;
    try {
      this.projects = (await wadd.projects()).map(toProject);
    } catch {
      // wadd unreachable: keep the last list.
    }
  }

  private async refreshSpecs() {
    try {
      this.specs = await wadd.specs();
    } catch {
      // wadd unreachable: keep the last list.
    }
  }

  subscribe(fn: (t: Topic) => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  /** Who this machine is linked to, once wadd has said (null: not linked). */
  async linkInfo(): Promise<{ machineId: string | null; ownerUid: string | null; machineName: string | null; connected: boolean }> {
    await this.firstSnap;
    return { machineId: this.snap?.machine_id ?? null, ownerUid: this.snap?.owner_uid ?? null, machineName: this.snap?.machine ?? null, connected: this.connected };
  }

  /** This machine's id in the account (the heartbeat's), so the account's copy of it can be left out. */
  cloudMachineId(): string | null {
    return this.snap?.machine_id ?? null;
  }

  defaultMachineId() {
    return THIS_MACHINE;
  }

  // ---------------------------------------------------------------- people
  async me(): Promise<PublicUser> {
    return { username: LOCAL_USER, displayName: this.snap?.machine ?? "This machine", color: "#c6ff1f", onboarded: onboarded.get() };
  }
  async signOut() {}
  async setOnboarded() {
    onboarded.set();
  }
  async users() {
    return [await this.me()];
  }
  async apps() {
    return catalog as App[];
  }

  // ------------------------------------------------------------ wadspaces
  private live(id: string): MachineWorkspace | undefined {
    return this.snap?.workspaces.find((w) => w.id === id);
  }

  private assemble(id: string): Wadspace | undefined {
    const entry = this.lib.get(id);
    const installed = this.specs.find((s) => s.id === id);
    const preset = presetWadspace(id);
    const spec = entry?.spec ?? (preset && { ...preset, advanced: { ...preset.advanced, projects: knownProjectIds(this.projects, presetProjects(id)) } }) ?? (installed && fromInstalled(installed));
    if (!spec) return undefined;
    const live = this.live(id);
    return {
      ...spec,
      advanced: withProjects(spec.advanced),
      // The machine's name for it wins: that's what the kiosk shows.
      name: entry?.spec.name ?? installed?.name ?? spec.name,
      owner: LOCAL_USER,
      visibility: entry?.visibility ?? "private",
      sharedWith: [],
      installed: !!installed,
      local: !!installed && live?.state.image_present !== false,
      sizeMB: 0,
      // One without a saved design: when this app first saw it, so it keeps
      // its place in lists sorted by time.
      updatedAt: entry?.updatedAt ?? this.seenAt,
      templateId: entry?.templateId,
      preset: !entry && !!preset,
      ...(installed?.kind === "app" && { app: true }),
      ...(installed?.projects && { mountedProjects: installed.projects.map((p) => p.id) }),
      ...(entry?.deletedAt && { deletedAt: entry.deletedAt }),
    };
  }

  /** The wadspaces from before the layers (library designs and installed
   *  presets), for the migration (data/migrate.ts). */
  async listOldWadspaces() {
    await this.firstSnap;
    if (!this.specs.length) await this.refreshSpecs();
    await this.presetProjects().catch(() => {});
    const ids = new Set([...this.lib.entries().map((e) => e.spec.id), ...this.specs.map((s) => s.id)]);
    return [...ids].map((id) => this.assemble(id)).filter((w): w is Wadspace => !!w);
  }

  /** A preset on this machine opens with its projects: the first time it's
   *  seen, make the ones the user doesn't have (only then, so one deleted
   *  later stays deleted). */
  private async presetProjects() {
    if (!this.caps.projects) return;
    const todo = this.specs.filter((s) => !this.lib.get(s.id) && !presetProjectsMade.has(s.id) && presetProjects(s.id).length);
    if (!todo.length) return;
    for (const s of todo) {
      await ensureProjects(this, presetProjects(s.id));
      presetProjectsMade.add(s.id);
    }
    await this.refreshProjects();
  }

  async cancelBuild(id: string) {
    await wadd.cancelBuild(id);
  }

  async listBuilds() {
    if (!this.caps.localBuild) return [];
    const jobs = await wadd.builds();
    // Recent ones with their logs, so a reopened app shows where they are.
    return Promise.all(jobs.slice(0, 5).map(async (j) => toProgress(await wadd.build(j.id, 0))));
  }

  onBuild(fn: (b: BuildProgress) => void) {
    this.buildListeners.add(fn);
    return () => void this.buildListeners.delete(fn);
  }

  // ------------------------------------------------------------- projects
  private needProjects() {
    if (!this.caps.projects) throw new Unsupported("Projects on this machine (it needs a system update)");
  }

  // --------------------------------------------------------- saved sign-ins
  async listSignIns() {
    if (!this.caps.signins) return [];
    return wadd.signIns();
  }

  async createSignIn(input: { name: string; app: string; paths?: string[] }) {
    if (!this.caps.signins) throw new Unsupported("Saved sign-ins (this machine needs a system update)");
    const s = await wadd.createSignIn(input);
    this.emit("signins");
    return s;
  }

  async updateSignIn(id: string, patch: { name?: string; paths?: string[] }) {
    const s = await wadd.patchSignIn(id, patch);
    this.emit("signins");
    return s;
  }

  async signOutSignIn(id: string) {
    const s = await wadd.signOut(id);
    this.emit("signins");
    return s;
  }

  async deleteSignIn(id: string) {
    await wadd.deleteSignIn(id);
    this.emit("signins");
  }

  async listSecrets() {
    return this.caps.signins ? wadd.secretList() : [];
  }

  async listProjects() {
    if (!this.caps.projects) return [];
    await this.refreshProjects();
    return this.projects;
  }

  async saveProject(p: ProjectDraft) {
    this.needProjects();
    const { id, ...body } = cleanDraft(p);
    // A folder picked here is on this machine: wadd fills in its id; the name is the one the kiosk shows.
    if (body.source.kind === "folder" && !body.source.machineName) body.source = { ...body.source, machineName: this.snap?.machine ?? "" };
    const saved = toProject(id ? await wadd.putProject(id, body) : await wadd.createProject(body));
    this.projects = [...this.projects.filter((x) => x.id !== saved.id), saved];
    this.emit("projects");
    return saved;
  }

  async deleteProject(id: string, opts: { purge?: boolean } = {}) {
    this.needProjects();
    const { purged } = await wadd.deleteProject(id, !!opts.purge);
    this.projects = this.projects.filter((x) => x.id !== id);
    this.emit("projects");
    return { purged };
  }

  async projectStatus(id: string) {
    if (!this.caps.projects) return null;
    const s = await wadd.projectStatus(id);
    return {
      existsOnDisk: s.exists_on_disk,
      path: s.path,
      bytes: s.bytes,
      mountedIn: s.mounted_in,
      git: s.git ?? null,
      available: s.available ?? true,
      ...(s.reason && { reason: s.reason }),
    };
  }

  // ------------------------------------------------- folders and drives
  async listDrives() {
    this.needProjects();
    return wadd.drives();
  }

  async browseFolders(q: { path?: string; drive?: string }) {
    this.needProjects();
    return wadd.browse(q);
  }

  // --------------------------------------------------------------- GitHub
  /** An older wadd has no /api/github: say what to do rather than "Not Found". */
  private github<T>(call: () => Promise<T>): Promise<T> {
    return call().catch((e) => {
      if (e instanceof WaddError && e.status === 404 && /not found/i.test(e.message)) throw new Unsupported("GitHub repos on this machine (it needs a system update)");
      throw e;
    });
  }

  async githubStatus() {
    this.needProjects();
    return this.github(() => wadd.github());
  }

  async listGithubRepos(): Promise<GithubRepoList> {
    this.needProjects();
    try {
      const r = await this.github(() => wadd.githubRepos());
      return { login: r.login, repos: r.repos, updatedAt: null };
    } catch (e) {
      // No github_token on this machine.
      if (e instanceof WaddError && e.status === 409) return { login: null, repos: [], updatedAt: null, missing: "token" };
      throw e;
    }
  }

  async createGithubRepo(req: NewRepo) {
    this.needProjects();
    const saved = toProject(
      await this.github(() =>
        wadd.createGithubRepo({
          name: req.name.trim(),
          private: req.private,
          ...(req.description?.trim() && { description: req.description.trim() }),
          ...(req.mountName?.trim() && { mountName: req.mountName.trim() }),
          ...(req.setup?.trim() && { setup: req.setup.trim() }),
        }),
      ),
    );
    this.projects = [...this.projects.filter((x) => x.id !== saved.id), saved];
    this.emit("projects");
    return saved;
  }

  // -------------------------------------------------------------- tailnet
  /** Tailscale's status, at most every few seconds unless asked for now. */
  private async freshTailnet(now = false) {
    if (!this.caps.tailnet && !now) return this.tailnet;
    if (now || Date.now() - this.tailnetAt > 5000) {
      this.tailnetAt = Date.now();
      this.tailnet = await wadd.tailnet().catch(() => this.tailnet);
      this.caps.tailnet = !!this.tailnet?.installed;
    }
    return this.tailnet;
  }

  async tailnetStatus() {
    return (await this.freshTailnet(true)) ?? { installed: false };
  }

  async tailnetLogin() {
    const r = await wadd.tailnetLogin();
    return { url: r.url ?? null, online: !!r.online };
  }

  async tailnetLogout() {
    await wadd.tailnetLogout();
    await this.freshTailnet(true);
    this.emit("machines");
  }

  async cancelLaunch(id: string) {
    await wadd.cancelLaunch(id);
  }

  async listLaunches() {
    if (!this.caps.projects) return [];
    const jobs = await wadd.launches();
    return Promise.all(jobs.slice(0, 5).map(async (j) => toLaunchProgress(await wadd.launch(j.id, 0))));
  }

  onLaunch(fn: (l: LaunchProgress) => void) {
    this.launchListeners.add(fn);
    return () => void this.launchListeners.delete(fn);
  }

  // ------------------------------------------------------------- machine
  private toContainer(w: MachineWorkspace, view: string): Container {
    const st = w.state;
    const d = st.download;
    return {
      id: w.id,
      wadspaceId: w.id,
      status: st.container === "running" ? "running" : "stopped",
      mode: w.display === "host" ? "local" : "stream",
      startedAt: new Date(st.since * 1000).toISOString(),
      phase: st.phase,
      error: st.error,
      download:
        st.phase === "pulling"
          ? { progress: d?.total_bytes ? d.done_bytes / d.total_bytes : st.progress, label: d ? downloadLabel(d) : (st.message ?? "downloading") }
          : null,
      onScreen: view === `workspace:${w.id}`,
      hotkey: w.hotkey,
      native: w.display === "host",
    };
  }

  /** CPU, memory and GPU from wadd, at most every few seconds. */
  private async freshMetrics() {
    if (this.caps.history && Date.now() - this.metricsAt > 3000) {
      this.metricsAt = Date.now();
      this.metrics = await wadd.metrics().catch(() => null);
    }
    return this.metrics;
  }

  async listMachines(): Promise<Machine[]> {
    await this.firstSnap;
    const s = this.snap;
    const m = this.connected ? await this.freshMetrics() : null;
    const t = this.connected ? await this.freshTailnet() : this.tailnet;
    return [
      {
        id: THIS_MACHINE,
        name: s?.machine ?? "this machine",
        label: "This machine",
        os: s ? `WadSpaces · wadd ${s.version}` : "WadSpaces",
        status: this.connected ? "online" : "offline",
        linked: !!s?.enrolled,
        cpu: m?.cpu ?? null,
        ram: m?.mem ?? null,
        gpu: m?.gpu ?? "",
        ip: "127.0.0.1",
        containers: (s?.workspaces ?? []).map((w) => this.toContainer(w, s!.view)),
        version: s?.version,
        tailnet: t?.installed && t.loggedIn ? { online: !!t.online, ip: t.ip ?? null, dnsName: t.dnsName ?? null } : null,
      },
    ];
  }

  async container(_machineId: string, containerId: string, action: ContainerAction) {
    if (action === "remove") {
      await wadd.remove(containerId);
      await this.refreshSpecs();
      this.emit("wadspaces");
      return;
    }
    await wadd.action(containerId, action);
  }

  async linkMachine(code: string) {
    await wadd.enroll(code.trim().toUpperCase());
  }

  // ---------------------------------------------------------------- focus
  async getFocus() {
    await this.firstSnap;
    const s = this.snap?.session;
    const now = Date.now();
    if (!s || s.mode !== "focus" || s.expired) return { focus: null, now };
    const minutes = s.minutes ?? 25;
    // The clock starts when one is first opened; until then show the full time.
    const endsAt = s.ends_at ? s.ends_at * 1000 : now + minutes * 60_000;
    return { focus: { wadspaceIds: s.workspaces, startedAt: endsAt - minutes * 60_000, endsAt }, now };
  }

  async lastSession() {
    return lastSession.get();
  }

  async runs(q: { wadspaceId?: string; machineId?: string }): Promise<ContainerRun[]> {
    if (!this.caps.history) return [];
    return (await wadd.runs(q.wadspaceId)).map((r) => ({
      id: r.id,
      wadspaceId: r.wadspaceId,
      wadspaceName: r.wadspaceName,
      machineId: THIS_MACHINE,
      user: LOCAL_USER,
      mode: r.mode,
      projects: r.projects ?? [],
      startedAt: iso(r.startedAt)!,
      endedAt: iso(r.endedAt),
    }));
  }

  // --------------------------------------------------------------- images
  async uploadImage(file: File) {
    // Kept inline in the library: small enough once downscaled.
    return imageDataUrl(file, { max: 1920, quality: 0.82 });
  }
}
