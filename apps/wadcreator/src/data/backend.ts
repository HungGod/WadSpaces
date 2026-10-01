// What the pages need from "the server". Two implementations, picked at build
// time by VITE_TARGET (see index.ts):
//
//   offline  local/  wadd on this machine (HTTP + server-sent events); the
//                    library and drafts are kept on the machine.
//   online   cloud/  Firebase Auth and Firestore, and the machines' cloud
//                    relay (users/{uid}/machines/*/commands).
//
// The UI keys people by username (owner, sharedWith, run history); each
// backend translates to whatever it stores.
import { dropFileIcons } from "@core/model";
import type { GithubRepo, Project, ProjectDraft, ProjectStatus } from "@core/projects";
import type { App, ContainerRun, Draft, FocusLock, LastSession, Machine, PublicUser, TailnetStatus, Wadspace } from "@/lib/types";

export interface Caps {
  /** Sign-in, profiles and other people. */
  accounts: boolean;
  /** Share wadspaces with other users. */
  sharing: boolean;
  /** Build images on this machine (wadd + podman). */
  localBuild: boolean;
  /** More than one machine to manage (the relay). */
  multiMachine: boolean;
  /** Logs and health for this machine. */
  diagnostics: boolean;
  /** Container history (runs). */
  history: boolean;
  /** GitHub repositories cloned onto the machine and mounted into wadspaces at launch. */
  projects: boolean;
  /** Machines reach each other over the user's tailnet (Tailscale). */
  tailnet: boolean;
  /** Run a wadspace on another of the user's trusted machines. */
  remoteRun: boolean;
}

export type WadspaceInput = Pick<Wadspace, "name" | "description" | "visibility" | "layout" | "advanced" | "agent" | "dockerfile" | "templateId"> & {
  sharedWith?: string[];
};

export type WadspacePatch = Partial<Pick<Wadspace, "name" | "description" | "visibility" | "sharedWith" | "layout" | "advanced" | "agent" | "dockerfile">>;

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
  /** On the machine's screen or streamed; only the wadspace's own display for now. */
  view?: "screen" | "stream";
  /** Restart it when it's running with other projects. */
  restart?: boolean;
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
export type Topic = "user" | "wadspaces" | "drafts" | "machines" | "focus" | "session" | "projects" | "github";

export interface Backend {
  readonly target: "offline" | "online";
  readonly caps: Caps;

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
  deleteWadspace(id: string): Promise<void>;

  listDrafts(): Promise<Draft[]>;
  getDraft(id: string): Promise<Draft>;
  saveDraft(id: string | null, input: DraftInput): Promise<Draft>;
  deleteDraft(id: string): Promise<void>;

  listMachines(): Promise<Machine[]>;
  /** Install if needed, start, and show a wadspace on a machine's screen. */
  open(machineId: string, wadspaceId: string): Promise<void>;
  container(machineId: string, containerId: string, action: ContainerAction): Promise<void>;
  setAllowRemote(machineId: string, allow: boolean): Promise<void>;
  /** Online: a one-time code to link a new machine (valid 15 minutes). */
  createEnrollCode?(machineName: string): Promise<string>;
  /** Offline: link this machine to an account with a code from the online app. */
  linkMachine?(code: string): Promise<void>;

  getFocus(): Promise<{ focus: FocusLock | null; now: number }>;
  startFocus(machineId: string, wadspaceIds: string[], minutes: number): Promise<void>;
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
