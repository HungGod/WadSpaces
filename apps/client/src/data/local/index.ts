// The offline backend: this machine, through wadd.
//
// wadd's server-sent events give a live snapshot of every workspace (and of
// builds); the Builder's documents are kept in wadd's library (layers.ts).
//
// Projects are wadd's too (/api/projects): it keeps them, syncs them with the
// account when the machine is linked, clones them from GitHub with the
// machine's github_token (/api/github) and mounts the clones when it launches
// a wadspace (/api/launches). Tailscale is wadd's as well (/api/tailnet).
import { cleanDraft, toProjectDoc, type Project, type ProjectDraft } from "@core/projects";
import { imageDataUrl } from "@/lib/images";
import { THIS_MACHINE } from "@/lib/machine";
import type { Container, ContainerRun, Machine, PublicUser, TailnetStatus } from "@/lib/types";
import {
  waddEvents,
  WaddError,
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
import { toLaunchProgress, toProgress } from "./builds";
import { lastSession, onboarded } from "./store";
import { WaddLayerDocs, WaddMachine } from "./layers";
import type { BrowserSetup, Extensions, LayerKey, Template, Wadspace } from "@core/layers";
import type { LayerLibrary, LayerPatch } from "../backend";
import type { RunItem } from "../layers";

export { THIS_MACHINE };
const LOCAL_USER = "local";
const iso = (t: number | null) => (t == null ? null : new Date(t * 1000).toISOString());

/** wadd's project document, minus what only wadd needs (it keeps `legacy`:
 *  a folder from before projects were GitHub repos). */
function toProject(p: WaddProject): Project {
  return toProjectDoc(p.id, p as unknown as Record<string, unknown>, (t) => (typeof t === "number" ? t : 0));
}

export class LocalBackend implements Backend {
  readonly target = "offline" as const;
  readonly caps: Caps = {
    sharing: false,
    localBuild: false, // set by init() when this wadd can build
    history: false, // set by init() when this wadd keeps run history
    projects: false, // set by init() when this wadd has projects
    copies: false, // set by init() along with projects: this wadd makes copies
    tailnet: false, // set by init() when Tailscale is installed here
    signins: false, // set by init() when this wadd keeps saved sign-ins
  };

  private snap: Snapshot | null = null;
  private connected = false;
  private listeners = new Set<(t: Topic) => void>();
  private buildListeners = new Set<(b: BuildProgress) => void>();
  private launchListeners = new Set<(l: LaunchProgress) => void>();
  private projects: Project[] = [];
  private firstSnap: Promise<void>;
  private gotFirstSnap!: () => void;
  private metrics: Metrics | null = null;
  private metricsAt = 0;
  private tailnet: TailnetStatus | null = null;
  private tailnetAt = 0;
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
    this.caps.copies = f.projects;
    this.caps.signins = f.signins;
    this.tailnet = f.tailnet;
    this.tailnetAt = Date.now();
    this.caps.tailnet = !!f.tailnet?.installed;
    if (this.caps.projects) await this.refreshProjects();
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
  listExtensions() {
    return this.docs.extensions.list();
  }
  saveExtensions(e: Extensions) {
    return this.docs.extensions.put(e).then((x) => (this.emit("extensions"), x));
  }
  patchExtensions(id: string, patch: LayerPatch) {
    return this.docs.extensions.patch(id, patch).then((x) => (this.emit("extensions"), x));
  }
  async deleteExtensions(id: string) {
    await this.machine.deleteImage(`custom:${id}`);
    await this.docs.extensions.remove(id);
    this.emit("extensions");
    this.emit("images");
  }
  listOldCustomizations() {
    return this.docs.customizations.list();
  }
  deleteOldCustomization(id: string) {
    return this.docs.customizations.remove(id);
  }
  listWadspaces() {
    return this.docs.wadspaces.list();
  }
  async saveWadspace(w: Wadspace) {
    const saved = (await this.docs.wadspaces.put(w)) as Wadspace;
    this.emit("wadspaces");
    return saved;
  }
  /** Deleted softly: off this machine too (it's installed again when it's built or launched). */
  async patchWadspace(id: string, patch: LayerPatch) {
    const saved = (await this.docs.wadspaces.patch(id, patch)) as Wadspace;
    if (patch.deletedAt) await this.machine.uninstall(id);
    this.emit("wadspaces");
    return saved;
  }
  async deleteWadspace(id: string) {
    await this.machine.uninstall(id);
    await this.docs.wadspaces.remove(id);
    this.emit("wadspaces");
  }
  async installWadspace(w: Wadspace, lib: LayerLibrary) {
    await this.machine.install(w, lib);
    this.emit("machines");
  }
  makeCopy(paths: string[]) {
    return this.machine.makeCopy(paths);
  }
  deleteCopy(id: string) {
    return this.machine.deleteCopy(id);
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
  /** Launched together; kept as the last session for Home's Jump back in
   *  (a throwaway run's workspace is gone after it, so it isn't kept). */
  async launchItems(items: RunItem[], focusMinutes: number | null, lib: LayerLibrary) {
    const ids = await this.machine.launch(items, focusMinutes, lib);
    const again = ids.filter((id) => !id.startsWith("run-") && !id.startsWith("browser-run-"));
    if (again.length) lastSession.set({ kind: focusMinutes ? "focus" : "wadspace", wadspaceIds: again, machineId: THIS_MACHINE, ...(focusMinutes && { minutes: focusMinutes }) });
    this.emit("session");
    return ids;
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
          // A project changed (here, or synced from the account).
          case "projects":
            this.refreshProjects().then(() => this.emit("projects"));
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

  async browseFolders(q: { path?: string; drive?: string; files?: boolean }) {
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
    return {
      id: w.id,
      wadspaceId: w.id,
      status: st.container === "running" ? "running" : "stopped",
      mode: w.display === "host" ? "local" : "stream",
      startedAt: new Date(st.since * 1000).toISOString(),
      phase: st.phase,
      error: st.error,
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
      this.emit("machines");
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
