// What the pages need from "the server". Three implementations, picked at
// build time by VITE_TARGET (see index.ts and lib/machine.ts):
//
//   offline  local/    wadd on this machine (HTTP + server-sent events); the
//                      library and drafts are kept on the machine.
//   online   cloud/    Firebase Auth and Firestore, and the machines' cloud
//                      relay (users/{uid}/machines/*/commands).
//   machine  machine/  both: the account for you and your designs, wadd for
//                      this machine.
//
// The UI keys people by username (owner, sharedWith, run history); each
// backend translates to whatever it stores.
import { dropFileIcons } from "@core/model";
import type { GithubRepo, Project, ProjectDraft, ProjectStatus } from "@core/projects";
import type { App, ContainerRun, Draft, FocusLock, LastSession, Machine, PublicUser, TailnetStatus, Wadspace } from "@/lib/types";
import type { WaddSecret, WaddSignIn } from "@/lib/wadd";
import type { BrowserSetup, Customization, LayerKey, Library, Template, WadspaceV2 } from "@core/layers";
import type { ImageRow, RunItem } from "./layers";

export interface Caps {
  /** Share wadspaces with other users. */
  sharing: boolean;
  /** Build images on this machine (wadd + podman). */
  localBuild: boolean;
  /** Container history (runs). */
  history: boolean;
  /** GitHub repositories cloned onto the machine and mounted into wadspaces at launch. */
  projects: boolean;
  /** Machines reach each other over the user's tailnet (Tailscale). */
  tailnet: boolean;
  /** Saved sign-ins, kept on this machine and mounted into wadspaces. */
  signins: boolean;
}

export type WadspaceInput = Pick<Wadspace, "name" | "description" | "visibility" | "layout" | "advanced" | "agent" | "dockerfile" | "templateId"> & {
  sharedWith?: string[];
};

export type WadspacePatch = Partial<Pick<Wadspace, "name" | "description" | "visibility" | "sharedWith" | "layout" | "advanced" | "agent" | "dockerfile">> & {
  /** Set: deleted, not for good. null: restored. */
  deletedAt?: string | null;
};

export type DraftInput = Omit<Draft, "id" | "owner" | "updatedAt">;

export type ContainerAction = "start" | "stop" | "restart" | "download" | "remove";

/** A build's state plus the log lines from line `from` on. */
export interface BuildProgress {
  id: string;
  wadspaceId: string;
  name: string;
  status: "building" | "done" | "error";
  progress: number;
  error?: string | null;
  from: number;
  lines: string[];
  /** A rebuilt wadspace that's running needs a restart to use the new image. */
  restartRequired?: boolean;
  /** A layer's image ("template:<id>" / "custom:<id>"), for the Builder's states. */
  layer?: string | null;
}

/** One thing a launch gets ready before the wadspace starts: its image, or a project's folder. */
export interface LaunchPart {
  /** "image", or the project's id. */
  key: string;
  kind: "image" | "project";
  name: string;
  state: "waiting" | "working" | "done" | "error";
  /** 0..1, or null while it can't tell. */
  progress: number | null;
  message: string | null;
}

/** A launch's state (wadd/launches.py) plus its log lines from line `from` on. */
export interface LaunchProgress {
  id: string;
  wadspaceId: string;
  name: string;
  /** Project ids it mounts. */
  projects: string[];
  status: "queued" | "running" | "done" | "error" | "cancelled";
  progress: number;
  phase: string;
  error?: string | null;
  parts: LaunchPart[];
  from: number;
  lines: string[];
}

export interface LaunchRequest {
  wadspaceId: string;
  projectIds: string[];
  /** Restart it when it's running with other projects. */
  restart?: boolean;
  /** Start it without switching the screen to it. */
  background?: boolean;
}

/** Offline: whether wadd has a github_token and whose it is. Online: whether
 *  one of your machines has shared your repositories (then it has a token). */
export interface GithubStatus {
  token: boolean;
  login: string | null;
  /** GitHub refused the token, or couldn't be reached. */
  error?: string;
}

/** Your repositories, to add as projects. */
export interface GithubRepoList {
  login: string | null;
  repos: GithubRepo[];
  /** Online: when a machine last shared the list (epoch ms). Offline: null, it's live. */
  updatedAt: number | null;
  /** Why there's no list: no github_token on this machine (offline), or no
   *  machine has shared one yet (online). */
  missing?: "token" | "shared";
}

/** A new repository on GitHub (private unless asked), and a project for it. */
export interface NewRepo {
  name: string;
  private: boolean;
  description?: string;
  mountName?: string;
  setup?: string;
}

/** A filesystem on this machine (GET /api/drives), for a drive project. */
export interface HostDrive {
  uuid: string;
  label: string | null;
  fstype: string;
  /** Bytes. */
  size: number | null;
  /** Where it's mounted now, if it is. */
  mountpoint: string | null;
  removable: boolean;
  model: string | null;
}

/** One folder's subfolders (GET /api/fs/browse). With no path: the places you
 *  may pick from. In a drive, paths are relative to its root. */
export interface FolderListing {
  path: string | null;
  parent: string | null;
  dirs: { name: string; path: string }[];
}

/** What changed, so the store reloads just that. "github": the repo list (pages listen themselves). */
export type Topic =
  | "user"
  | "wadspaces"
  | "drafts"
  | "machines"
  | "focus"
  | "session"
  | "projects"
  | "signins"
  | "github"
  | "templates"
  | "customizations"
  | "browsers"
  | "images";

/** A change to a layer document: soft delete (`deletedAt`) or restore (null). */
export interface LayerPatch {
  deletedAt?: string | null;
  /** Migrated from before the layers: null once its layers are built. */
  legacyImage?: string | null;
}

/** Everything the Builder's documents are, for the calls that need them all. */
export interface LayerLibrary extends Library {
  wadspaces: WadspaceV2[];
  browsers: BrowserSetup[];
}

export interface Backend {
  readonly target: "offline" | "online" | "machine";
  readonly caps: Caps;

  // -------------------------------------------------- the Builder's layers
  // Documents (deleted ones included: `deletedAt`). Saving creates or
  // replaces by id; deleting is for good (soft delete is a patch).
  listTemplates(): Promise<Template[]>;
  saveTemplate(t: Template): Promise<Template>;
  patchTemplate(id: string, patch: LayerPatch): Promise<Template>;
  deleteTemplate(id: string): Promise<void>;
  listCustomizations(): Promise<Customization[]>;
  saveCustomization(c: Customization): Promise<Customization>;
  patchCustomization(id: string, patch: LayerPatch): Promise<Customization>;
  deleteCustomization(id: string): Promise<void>;
  /** Saved on a machine (offline, the machine app): installed there too. */
  listWadspacesV2(): Promise<WadspaceV2[]>;
  saveWadspaceV2(w: WadspaceV2, lib: LayerLibrary): Promise<WadspaceV2>;
  patchWadspaceV2(id: string, patch: LayerPatch, lib: LayerLibrary): Promise<WadspaceV2>;
  deleteWadspaceV2(id: string): Promise<void>;
  listBrowsers(): Promise<BrowserSetup[]>;
  saveBrowser(b: BrowserSetup): Promise<BrowserSetup>;
  patchBrowser(id: string, patch: LayerPatch): Promise<BrowserSetup>;
  deleteBrowser(id: string): Promise<void>;
  /** The layer images on the launch machine (online: its heartbeat). */
  listImages(): Promise<ImageRow[]>;
  /** Builds a layer's image there (a customization's template first when needed): the build's id. */
  buildLayer(key: LayerKey, lib: LayerLibrary): Promise<string>;
  /** Removes a layer's image there (a template or customization deleted for good). */
  deleteImage(key: LayerKey): Promise<void>;
  /** Starts what the launcher picked, together (a focus session with minutes):
   *  the workspaces' ids. Their images are built first where they need it. */
  launchItems(items: RunItem[], focusMinutes: number | null, lib: LayerLibrary): Promise<string[]>;
  /** The launch machine's screen, which the Builder lays desktops out at. */
  machineScreen(): Promise<{ width: number; height: number }>;
  /** On a library's first load: the starter templates (Writing, Dev), made
   *  once as the user's own. The ones made now. */
  createStarters(): Promise<Template[]>;

  /** Settle what this backend can do before the app renders (e.g. which wadd). */
  init?(): Promise<void>;

  /** Where "Open" goes by default: this machine (offline), or the user's pick (online). */
  defaultMachineId(): string | null;
  /** Online: remember which machine "Open" uses. */
  setDefaultMachine?(machineId: string): void;

  me(): Promise<PublicUser | null>;
  signOut(): Promise<void>;
  setOnboarded(): Promise<void>;
  /** People the UI may show: you, owners of wadspaces shared with you, share candidates. */
  users(): Promise<PublicUser[]>;

  apps(): Promise<App[]>;

  listWadspaces(): Promise<Wadspace[]>;
  getWadspace(id: string): Promise<Wadspace>;
  createWadspace(input: WadspaceInput): Promise<Wadspace>;
  patchWadspace(id: string, patch: WadspacePatch): Promise<Wadspace>;
  /** For good (patchWadspace's deletedAt is the undoable delete). */
  deleteWadspace(id: string): Promise<void>;
  /** Offline: install `copy` (a clone of `from`) on this machine with `from`'s
   *  image, so it opens without a build. False when `from` isn't installed here. */
  installCopy?(copy: Wadspace, from: string): Promise<boolean>;

  listDrafts(): Promise<Draft[]>;
  getDraft(id: string): Promise<Draft>;
  saveDraft(id: string | null, input: DraftInput): Promise<Draft>;
  deleteDraft(id: string): Promise<void>;

  listMachines(): Promise<Machine[]>;
  /** Install if needed, start, and show a wadspace on a machine's screen. */
  open(machineId: string, wadspaceId: string): Promise<void>;
  container(machineId: string, containerId: string, action: ContainerAction): Promise<void>;
  /** Online: a one-time code to link a new machine (valid 15 minutes). */
  createEnrollCode?(machineName: string): Promise<string>;
  /** Offline: link this machine to an account with a code from the online app. */
  linkMachine?(code: string): Promise<void>;

  getFocus(): Promise<{ focus: FocusLock | null; now: number }>;
  startFocus(machineId: string, wadspaceIds: string[], minutes: number): Promise<void>;
  /** Offline: a session with these wadspaces on this machine, launched by the
   *  app (they aren't started here). With minutes, a focus session. */
  beginSession?(wadspaceIds: string[], minutes: number | null): Promise<void>;
  lastSession(): Promise<LastSession | null>;

  runs(q: { wadspaceId?: string; machineId?: string }): Promise<ContainerRun[]>;

  /** A picked image (wallpaper, custom icon), downscaled to a data URL the wadspace can keep. */
  uploadImage(file: File): Promise<string>;

  /** Changes pushed from wadd's events or Firestore listeners. */
  subscribe(fn: (topic: Topic) => void): () => void;

  /** Projects (core/projects.ts), without the deleted ones. */
  listProjects(): Promise<Project[]>;
  /** Create (no id) or update a project. */
  saveProject(p: ProjectDraft): Promise<Project>;
  /** Leaves a tombstone, so the deletion syncs. Offline, `purge` also removes
   *  the folder from this machine (refused while a wadspace mounts it). */
  deleteProject(id: string, opts?: { purge?: boolean }): Promise<{ purged: boolean }>;
  /** Offline: the clone on this machine. Online: null (the files are on the machines). */
  projectStatus(id: string): Promise<ProjectStatus | null>;

  /** Saved sign-ins on this machine (none online: they never leave it). */
  listSignIns(): Promise<WaddSignIn[]>;
  /** A new, empty one for "web" (any web app) or an app; `paths` for an app
   *  the catalog doesn't know. */
  createSignIn(input: { name: string; app: string; paths?: string[] }): Promise<WaddSignIn>;
  /** Rename it, or change an unknown app's files. */
  updateSignIn(id: string, patch: { name?: string; paths?: string[] }): Promise<WaddSignIn>;
  /** Forget what it saved: every wadspace using it is signed out (not while one runs). */
  signOutSignIn(id: string): Promise<WaddSignIn>;
  /** Remove it (not while a wadspace here uses it). */
  deleteSignIn(id: string): Promise<void>;
  /** The machine's secrets (names, never values), e.g. github_token. */
  listSecrets(): Promise<WaddSecret[]>;

  /** Is there a GitHub token to list and clone your repositories with. */
  githubStatus(): Promise<GithubStatus>;
  /** Your repositories, newest push first (`gh repo list`). */
  listGithubRepos(): Promise<GithubRepoList>;
  /** Offline: make the repository on GitHub, then its project. Online: Unsupported (github.com/new). */
  createGithubRepo(req: NewRepo): Promise<Project>;
  /** Online: ask the online machines to share the repo list again (and sync
   *  projects); resolves with how many were asked. */
  refreshGithubRepos?(): Promise<number>;

  /** Offline: the drives on this machine, for a drive project. */
  listDrives?(): Promise<HostDrive[]>;
  /** Offline: a folder's subfolders, on this machine or inside a drive (by uuid). */
  browseFolders?(q: { path?: string; drive?: string }): Promise<FolderListing>;

  /** Offline: Tailscale on this machine (caps.tailnet). */
  tailnetStatus?(): Promise<TailnetStatus>;
  /** A login URL to open (or scan) to add this machine to your tailnet; null when it's on already. */
  tailnetLogin?(): Promise<{ url: string | null; online: boolean }>;
  tailnetLogout?(): Promise<void>;

  /** Get the image and the projects' folders ready, then start and show the
   *  wadspace. Throws RestartNeeded when it's running with other projects. */
  launch(req: LaunchRequest): Promise<LaunchProgress>;
  cancelLaunch(id: string): Promise<void>;
  /** Launches already running or finished (e.g. after the app reloads). */
  listLaunches?(): Promise<LaunchProgress[]>;
  /** Progress and log lines as they come. */
  onLaunch?(fn: (l: LaunchProgress) => void): () => void;

  /** Build a saved wadspace's image; returns the build's id. */
  startBuild?(wadspaceId: string): Promise<string>;
  cancelBuild?(buildId: string): Promise<void>;
  /** Builds already running or finished (e.g. after the app reloads). */
  listBuilds?(): Promise<BuildProgress[]>;
  /** Progress and log lines as they come. */
  onBuild?(fn: (b: BuildProgress) => void): () => void;
}

const STEPS: Draft["step"][] = ["apps", "projects", "customize"];

/** A stored draft as the Builder knows it now: no file shortcuts, and one
 *  saved on a step that's gone (the old Files step) reopens on Apps. Repos
 *  become projects in the data layer (data/projects.ts). */
export function migrateDraft(d: Draft): Draft {
  return { ...d, layout: dropFileIcons(d.layout), step: STEPS.includes(d.step) ? d.step : "apps" };
}

export class Unsupported extends Error {
  /** `message` replaces the generic "isn't available here yet". */
  constructor(what: string, message?: string) {
    super(message ?? `${what} isn't available here yet.`);
  }
}

/** The wadspace is running with other projects: launching again with these restarts it. */
export class RestartNeeded extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RestartNeeded";
  }
}
