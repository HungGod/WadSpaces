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
import type { ContainerRun, Machine, PublicUser } from "@/lib/types";
import type {
  Backend,
  BuildProgress,
  Caps,
  ContainerAction,
  LaunchProgress,
  NewRepo,
  Topic,
} from "../backend";
import { CloudBackend } from "../cloud";
import { LocalBackend } from "../local";
import type { ProjectDraft } from "@core/projects";
import type { BrowserSetup, Extensions, LayerKey, Template, Wadspace } from "@core/layers";
import type { LayerLibrary, LayerPatch } from "../backend";
import type { RunItem } from "../layers";

export class MachineBackend implements Backend {
  readonly target = "machine" as const;

  readonly local = new LocalBackend();
  readonly cloud = new CloudBackend({ thisMachine: () => this.local.cloudMachineId() });

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

  // ---------------------------------------------------- the Builder's layers
  // The documents are the account's; images, builds and launches this
  // machine's (a wadspace saved here is installed here too).
  listTemplates() {
    return this.cloud.listTemplates();
  }
  saveTemplate(t: Template) {
    return this.cloud.saveTemplate(t);
  }
  patchTemplate(id: string, patch: LayerPatch) {
    return this.cloud.patchTemplate(id, patch);
  }
  async deleteTemplate(id: string) {
    await this.local.deleteImage(`template:${id}`);
    await this.cloud.deleteTemplate(id);
  }
  listExtensions() {
    return this.cloud.listExtensions();
  }
  saveExtensions(e: Extensions) {
    return this.cloud.saveExtensions(e);
  }
  patchExtensions(id: string, patch: LayerPatch) {
    return this.cloud.patchExtensions(id, patch);
  }
  async deleteExtensions(id: string) {
    await this.local.deleteImage(`custom:${id}`);
    await this.cloud.deleteExtensions(id);
  }
  listOldCustomizations() {
    return this.cloud.listOldCustomizations();
  }
  deleteOldCustomization(id: string) {
    return this.cloud.deleteOldCustomization(id);
  }
  listWadspaces() {
    return this.cloud.listWadspaces();
  }
  saveWadspace(w: Wadspace) {
    return this.cloud.saveWadspace(w);
  }
  /** Deleted softly: off this machine too (installed again when it's built or launched). */
  async patchWadspace(id: string, patch: LayerPatch) {
    const saved = await this.cloud.patchWadspace(id, patch);
    if (patch.deletedAt) await this.local.machine.uninstall(id);
    return saved;
  }
  async deleteWadspace(id: string) {
    await this.local.machine.uninstall(id);
    await this.cloud.deleteWadspace(id);
  }
  /** Here: this machine is the one it launches on. */
  installWadspace(w: Wadspace, lib: LayerLibrary) {
    return this.local.installWadspace(w, lib);
  }
  makeCopy(paths: string[]) {
    return this.local.makeCopy(paths);
  }
  storage(fresh?: boolean) {
    return this.local.storage(fresh);
  }
  deleteCopy(id: string) {
    return this.local.deleteCopy(id);
  }
  listBrowsers() {
    return this.cloud.listBrowsers();
  }
  saveBrowser(b: BrowserSetup) {
    return this.cloud.saveBrowser(b);
  }
  patchBrowser(id: string, patch: LayerPatch) {
    return this.cloud.patchBrowser(id, patch);
  }
  deleteBrowser(id: string) {
    return this.cloud.deleteBrowser(id);
  }
  listImages() {
    return this.local.listImages();
  }
  buildLayer(key: LayerKey, lib: LayerLibrary) {
    return this.local.buildLayer(key, lib);
  }
  deleteImage(key: LayerKey) {
    return this.local.deleteImage(key);
  }
  launchItems(items: RunItem[], focusMinutes: number | null, lib: LayerLibrary) {
    return this.local.launchItems(items, focusMinutes, lib);
  }
  machineScreen() {
    return this.local.machineScreen();
  }
  owner() {
    return this.cloud.owner();
  }
  buildingLayers() {
    // Builds run here: their events say what's building.
    return [];
  }
  createStarters() {
    return this.cloud.createStarters();
  }

  // ---------------------------------------------------------------- people
  me(): Promise<PublicUser | null> {
    return this.cloud.me();
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

  /** Who this machine is linked to (wadd's enrollment). */
  linkInfo() {
    return this.local.linkInfo();
  }
  uid() {
    return this.cloud.uidNow();
  }

  // ------------------------------------------------------------ wadspaces
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

  // --------------------------------------------------------- saved sign-ins
  listSignIns() {
    return this.local.listSignIns();
  }
  createSignIn(input: { name: string; app: string; paths?: string[] }) {
    return this.local.createSignIn(input);
  }
  updateSignIn(id: string, patch: { name?: string; paths?: string[] }) {
    return this.local.updateSignIn(id, patch);
  }
  signOutSignIn(id: string) {
    return this.local.signOutSignIn(id);
  }
  deleteSignIn(id: string) {
    return this.local.deleteSignIn(id);
  }
  listSecrets() {
    return this.local.listSecrets();
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

  cancelLaunch(id: string) {
    return this.local.cancelLaunch(id);
  }
  listLaunches() {
    return this.local.listLaunches();
  }
  onLaunch(fn: (l: LaunchProgress) => void) {
    return this.local.onLaunch(fn);
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
