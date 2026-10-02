// The machine app's backend (VITE_TARGET=machine): the account and this
// machine together.
//
//   the account (cloud/)  who you are, your designs and drafts, your other
//                         machines, codes to link more
//   wadd (local/)         this machine: what's installed and running, builds,
//                         launches, focus, run history, projects (wadd syncs
//                         them with the account), GitHub, drives and folders
//
// A wadspace is the account's design when there is one, with this machine's
// state (installed, image here, mounted projects) on top; wadspaces only this
// machine has (presets on the stick, ones designed before it was linked) are
// listed too. This machine is THIS_MACHINE, never its heartbeat in the account.
import { THIS_MACHINE, isThisMachine } from "@/lib/machine";
import type { ContainerRun, Machine, PublicUser, Wadspace } from "@/lib/types";
import type {
  Backend,
  BuildProgress,
  Caps,
  ContainerAction,
  DraftInput,
  LaunchProgress,
  LaunchRequest,
  NewRepo,
  Topic,
  WadspaceInput,
  WadspacePatch,
} from "../backend";
import { CloudBackend } from "../cloud";
import { LocalBackend } from "../local";
import type { ProjectDraft } from "@core/projects";

export class MachineBackend implements Backend {
  readonly target = "machine" as const;

  readonly local = new LocalBackend();
  readonly cloud = new CloudBackend({ thisMachine: () => this.local.cloudMachineId() });
  private username: string | null = null;

  /** This machine's: what its wadd can do. Sharing isn't built yet. */
  get caps(): Caps {
    return this.local.caps;
  }

  async init() {
    await this.local.init();
  }

  subscribe(fn: (t: Topic) => void) {
    const a = this.cloud.subscribe(fn);
    const b = this.local.subscribe(fn);
    return () => {
      a();
      b();
    };
  }

  // ---------------------------------------------------------------- people
  async me(): Promise<PublicUser | null> {
    const me = await this.cloud.me();
    this.username = me?.username ?? null;
    return me;
  }
  signOut() {
    return this.cloud.signOut();
  }
  setOnboarded() {
    return this.cloud.setOnboarded();
  }
  users() {
    return this.cloud.users();
  }
  apps() {
    return this.cloud.apps();
  }

  /** Who this machine is linked to (wadd's enrollment). */
  linkInfo() {
    return this.local.linkInfo();
  }
  uid() {
    return this.cloud.uidNow();
  }

  // ------------------------------------------------------------ wadspaces
  /** The account's design with this machine's state on top. */
  private merge(design: Wadspace, here: Wadspace | undefined): Wadspace {
    return {
      ...design,
      installed: !!here?.installed,
      local: !!here?.local,
      ...(here?.mountedProjects && { mountedProjects: here.mountedProjects }),
    };
  }

  /** One only this machine has: yours, as far as the UI is concerned. */
  private own(here: Wadspace): Wadspace {
    return { ...here, owner: this.username ?? here.owner };
  }

  async listWadspaces() {
    const [designs, here] = await Promise.all([this.cloud.listWadspaces(), this.local.listWadspaces()]);
    const byId = new Map(here.map((w) => [w.id, w]));
    const fromAccount = designs.map((d) => this.merge(d, byId.get(d.id)));
    const ids = new Set(designs.map((d) => d.id));
    return [...fromAccount, ...here.filter((w) => !ids.has(w.id)).map((w) => this.own(w))];
  }

  async getWadspace(id: string) {
    const here = await this.local.getWadspace(id).catch(() => undefined);
    try {
      return this.merge(await this.cloud.getWadspace(id), here);
    } catch (e) {
      if (here) return this.own(here);
      throw e;
    }
  }

  createWadspace(input: WadspaceInput) {
    return this.cloud.createWadspace(input);
  }

  async patchWadspace(id: string, patch: WadspacePatch) {
    if (!this.cloud.knows(id)) return this.own(await this.local.patchWadspace(id, patch));
    const saved = await this.cloud.patchWadspace(id, patch);
    await this.local.mirrorInstalled(id, saved.name, saved.advanced.hotkey ?? null);
    return this.getWadspace(id);
  }

  async deleteWadspace(id: string) {
    if (this.cloud.owns(id)) await this.cloud.deleteWadspace(id);
    if (this.local.has(id)) await this.local.deleteWadspace(id);
  }

  // --------------------------------------------------------------- drafts
  listDrafts() {
    return this.cloud.listDrafts();
  }
  getDraft(id: string) {
    return this.cloud.getDraft(id);
  }
  saveDraft(id: string | null, input: DraftInput) {
    return this.cloud.saveDraft(id, input);
  }
  deleteDraft(id: string) {
    return this.cloud.deleteDraft(id);
  }

  // ------------------------------------------------------------- machines
  defaultMachineId() {
    return this.cloud.pickedMachine() ?? THIS_MACHINE;
  }
  setDefaultMachine(id: string) {
    this.cloud.setDefaultMachine(id);
  }

  async listMachines(): Promise<Machine[]> {
    const [here, others] = await Promise.all([this.local.listMachines(), this.cloud.listMachines()]);
    return [...here, ...others];
  }

  async open(machineId: string, wadspaceId: string) {
    if (!isThisMachine(machineId)) return this.cloud.open(machineId, wadspaceId);
    const design = this.cloud.knows(wadspaceId) ? await this.getWadspace(wadspaceId) : undefined;
    await this.local.open(machineId, wadspaceId, design);
  }

  container(machineId: string, containerId: string, action: ContainerAction) {
    return isThisMachine(machineId) ? this.local.container(machineId, containerId, action) : this.cloud.container(machineId, containerId, action);
  }

  createEnrollCode(machineName: string) {
    return this.cloud.createEnrollCode(machineName);
  }
  linkMachine(code: string) {
    return this.local.linkMachine(code);
  }

  // ---------------------------------------------------------------- focus
  getFocus() {
    return this.local.getFocus();
  }
  startFocus(machineId: string, wadspaceIds: string[], minutes: number) {
    return isThisMachine(machineId) ? this.local.startFocus(machineId, wadspaceIds, minutes) : this.cloud.startFocus();
  }
  async lastSession() {
    return (await this.local.lastSession()) ?? (await this.cloud.lastSession());
  }
  runs(q: { wadspaceId?: string; machineId?: string }): Promise<ContainerRun[]> {
    return this.local.runs(q);
  }

  /** Designs live in Firestore: the account's size limits. */
  uploadImage(file: File) {
    return this.cloud.uploadImage(file);
  }

  // ------------------------------------------------------------- projects
  listProjects() {
    return this.local.listProjects();
  }
  saveProject(p: ProjectDraft) {
    return this.local.saveProject(p);
  }
  deleteProject(id: string, opts?: { purge?: boolean }) {
    return this.local.deleteProject(id, opts);
  }
  projectStatus(id: string) {
    return this.local.projectStatus(id);
  }
  listDrives() {
    return this.local.listDrives();
  }
  browseFolders(q: { path?: string; drive?: string }) {
    return this.local.browseFolders(q);
  }

  // --------------------------------------------------------------- GitHub
  githubStatus() {
    return this.local.githubStatus();
  }
  listGithubRepos() {
    return this.local.listGithubRepos();
  }
  createGithubRepo(req: NewRepo) {
    return this.local.createGithubRepo(req);
  }

  /** The machine app signed this machine in to GitHub (src-tauri/src/github.rs):
   *  your other machines fetch the token from the account now. How many were asked. */
  githubSignedIn(): number {
    this.local.changed("github");
    const uid = this.cloud.uidNow();
    return uid ? this.cloud.tellMachines(uid, "sync-secrets") : 0;
  }

  // ----------------------------------------------------- launches, builds
  launch(req: LaunchRequest) {
    return this.local.launch(req);
  }
  cancelLaunch(id: string) {
    return this.local.cancelLaunch(id);
  }
  listLaunches() {
    return this.local.listLaunches();
  }
  onLaunch(fn: (l: LaunchProgress) => void) {
    return this.local.onLaunch(fn);
  }

  async startBuild(wadspaceId: string) {
    return this.local.startBuild(wadspaceId, await this.getWadspace(wadspaceId));
  }
  cancelBuild(id: string) {
    return this.local.cancelBuild(id);
  }
  listBuilds() {
    return this.local.listBuilds();
  }
  onBuild(fn: (b: BuildProgress) => void) {
    return this.local.onBuild(fn);
  }
}
