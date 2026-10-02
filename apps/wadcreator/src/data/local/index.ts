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
import { toBuildSpec } from "@core/build";
import catalog from "@core/catalog/apps.json";
import { defaultAdvanced, newWadspaceId, type WadspaceSpec } from "@core/model";
import { cleanDraft, toProjectDoc, type Project, type ProjectDraft } from "@core/projects";
import { presetProjects, presetWadspace } from "@core/presets";
import { toWaddSpec, type WaddSpec } from "@core/spec";
import { imageDataUrl } from "@/lib/images";
import type { App, Container, ContainerRun, Draft, Machine, PublicUser, TailnetStatus, Wadspace } from "@/lib/types";
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
  RestartNeeded,
  Unsupported,
  type Backend,
  type BuildProgress,
  type Caps,
  type ContainerAction,
  type DraftInput,
  type GithubRepoList,
  type LaunchProgress,
  type NewRepo,
  type LaunchRequest,
  type Topic,
  type WadspaceInput,
  type WadspacePatch,
} from "../backend";
import { ensureProjects, hasRepos, knownProjectIds, migrateRepos, withProjects } from "../projects";
import { buildRequest, toLaunchProgress, toProgress } from "./builds";
import { LocalLibrary, type LibraryEntry } from "./library";
import { lastSession, onboarded, presetProjectsMade } from "./store";

export const THIS_MACHINE = "this-machine";
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

  constructor() {
    this.firstSnap = new Promise((r) => (this.gotFirstSnap = r));
    // Don't hold the UI hostage if wadd is down: show what we have after a moment.
    setTimeout(() => this.gotFirstSnap(), 2500);
    this.connect();
  }

  /** Find out what this wadd can do (an older one on a stick predates builds). */
  async init() {
    const f = await wadd.features();
    this.caps.localBuild = f.builds;
    this.caps.history = f.runs;
    this.caps.projects = f.projects;
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

  /** Wadspaces and drafts saved before projects: their repos become projects. */
  private async migrateLibrary() {
    let changed = false;
    for (const e of this.lib.entries()) {
      if (!hasRepos(e.spec.advanced)) continue;
      await this.lib.put({ ...e, spec: { ...e.spec, advanced: await migrateRepos(this, e.spec.advanced) } });
      changed = true;
    }
    for (const d of this.lib.drafts()) {
      if (!hasRepos(d.advanced)) continue;
      await this.lib.putDraft({ ...d, advanced: await migrateRepos(this, d.advanced) });
      changed = true;
    }
    if (changed) {
      this.emit("wadspaces");
      this.emit("drafts");
    }
  }

  // ----------------------------------------------------------- live state
  private emit(t: Topic) {
    this.listeners.forEach((fn) => fn(t));
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
          // Tailscale's state changed (signed in, out, online): the event has no
          // stream links, so ask for the whole status.
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
    const now = new Date().toISOString();
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
      updatedAt: entry?.updatedAt ?? now,
      templateId: entry?.templateId,
      preset: !entry && !!preset,
      ...(installed?.projects && { mountedProjects: installed.projects.map((p) => p.id) }),
    };
  }

  async listWadspaces() {
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

  async getWadspace(id: string) {
    await this.firstSnap;
    const ws = this.assemble(id);
    if (!ws) throw new Error("That wadspace isn't on this machine.");
    return ws;
  }

  async createWadspace(input: WadspaceInput) {
    const now = new Date().toISOString();
    const spec: WadspaceSpec = {
      id: newWadspaceId(input.name),
      name: input.name,
      description: input.description,
      layout: input.layout,
      advanced: input.advanced ?? defaultAdvanced(tz()),
      ...(input.agent && { agent: input.agent }),
      ...(input.dockerfile && { dockerfile: input.dockerfile }),
    };
    await this.lib.put({ spec, visibility: input.visibility, templateId: input.templateId, createdAt: now, updatedAt: now });
    this.emit("wadspaces");
    return this.getWadspace(spec.id);
  }

  async patchWadspace(id: string, patch: WadspacePatch) {
    const current = await this.getWadspace(id);
    const now = new Date().toISOString();
    const prev: LibraryEntry = this.lib.get(id) ?? { spec: current, visibility: current.visibility, createdAt: now, updatedAt: now };
    const spec: WadspaceSpec = {
      ...prev.spec,
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.description !== undefined && { description: patch.description }),
      ...(patch.layout && { layout: patch.layout }),
      ...(patch.advanced && { advanced: patch.advanced }),
      ...("agent" in patch && { agent: patch.agent }),
      ...("dockerfile" in patch && { dockerfile: patch.dockerfile }),
    };
    await this.lib.put({ ...prev, spec, visibility: patch.visibility ?? prev.visibility, updatedAt: now });
    // The kiosk's own copy: its name and hotkey change now; the rest (apps,
    // wallpaper, run settings) takes effect when the image is rebuilt.
    const installed = this.specs.find((s) => s.id === id);
    if (installed && (installed.name !== spec.name || (installed.hotkey ?? null) !== (spec.advanced.hotkey ?? null))) {
      await wadd.update(id, { ...installed, name: spec.name, hotkey: spec.advanced.hotkey ?? null });
      await this.refreshSpecs();
    }
    this.emit("wadspaces");
    return this.getWadspace(id);
  }

  async deleteWadspace(id: string) {
    if (this.specs.some((s) => s.id === id)) {
      await wadd.remove(id);
      await this.refreshSpecs();
    }
    await this.lib.remove(id);
    this.emit("wadspaces");
  }

  // --------------------------------------------------------------- drafts
  async listDrafts() {
    return this.lib.drafts();
  }
  async getDraft(id: string) {
    const d = this.lib.draft(id);
    if (!d) throw new Error("That draft is gone.");
    return d;
  }
  async saveDraft(id: string | null, input: DraftInput) {
    const d: Draft = { ...input, id: id ?? crypto.randomUUID(), owner: LOCAL_USER, updatedAt: new Date().toISOString() };
    await this.lib.putDraft(d);
    this.emit("drafts");
    return d;
  }
  async deleteDraft(id: string) {
    await this.lib.removeDraft(id);
    this.emit("drafts");
  }

  // --------------------------------------------------------------- builds
  async startBuild(wadspaceId: string) {
    if (!this.caps.localBuild) throw new Unsupported("Building on this machine (it needs a newer wadd)");
    const ws = await this.getWadspace(wadspaceId);
    const req = await buildRequest(ws, this.specs.find((s) => s.id === wadspaceId), this.projects);
    const job = await wadd.createBuild(req.workspace, req.baseImage);
    await wadd.buildContext(job.id, req.tarball);
    return job.id;
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
    return (await this.freshTailnet(true)) ?? { installed: false, streams: [] };
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

  // ------------------------------------------------------------- launches
  async launch(req: LaunchRequest) {
    this.needProjects();
    let job;
    try {
      job = await wadd.createLaunch({ workspace: req.wadspaceId, projects: req.projectIds, view: req.view, restart: req.restart });
    } catch (e) {
      // wadd won't restart a running wadspace unasked; the app asks first.
      if (e instanceof WaddError && e.status === 409 && /pass restart/.test(e.message)) throw new RestartNeeded(e.message);
      throw e;
    }
    lastSession.set({ kind: "wadspace", wadspaceIds: [req.wadspaceId], machineId: THIS_MACHINE });
    this.emit("session");
    return toLaunchProgress({ ...job, from: 0, lines: [] });
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
    const stream = this.tailnet?.online ? this.tailnet.streams?.find((x) => x.wsId === w.id) : undefined;
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
      streamUrl: stream?.url ?? null,
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
        allowRemote: !!s?.enrolled,
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

  async open(_machineId: string, wadspaceId: string) {
    const installed = this.specs.find((s) => s.id === wadspaceId);
    if (!installed) {
      const ws = this.assemble(wadspaceId);
      if (ws && ws.advanced.image) {
        // Designed elsewhere but the image is known: add it to the machine.
        const { spec } = toBuildSpec(ws, { image: ws.advanced.image });
        await wadd.create(toWaddSpec(spec));
        await this.refreshSpecs();
      } else {
        throw new Error(this.caps.localBuild ? "Build this wadspace first: open it in the Builder and press Build." : "This wadspace hasn't been built on this machine yet.");
      }
    }
    await wadd.action(wadspaceId, "switch");
    lastSession.set({ kind: "wadspace", wadspaceIds: [wadspaceId], machineId: THIS_MACHINE });
    this.emit("session");
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

  async startFocus(_machineId: string, wadspaceIds: string[], minutes: number) {
    await wadd.session(wadspaceIds, Math.max(1, Math.round(minutes)));
    lastSession.set({ kind: "focus", wadspaceIds, machineId: THIS_MACHINE, minutes });
    this.emit("session");
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
