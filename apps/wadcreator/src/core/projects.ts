// Projects: folders of work mounted read-write at ~/Desktop/<mountName> when
// a wadspace launches, so one image runs with whichever projects you pick and
// the work outlives the container. A project is one of:
//
//   git     a GitHub repository, cloned onto each machine that opens it
//           (/var/lib/wadspaces-projects/<id>). GitHub is where the work lives
//           between machines: you commit and push yourself, and wadd
//           fast-forwards a clean clone when it opens it.
//   folder  a directory that's already on one machine; it opens only there.
//   drive   a filesystem by UUID (a second disk, a USB drive), or a folder in
//           it; it opens on whichever machine it's plugged into.
//
// The document is the same everywhere: wadd's project store on a machine
// (wadd's projects, apps/wadd/src/projects.rs) and users/{uid}/projects/{id} in
// Firestore, which wadd's cloud relay syncs both ways (last writer wins on
// updatedAt). wadd's own `synced` and `legacy` flags never leave the machine.
// The functions are wad-core's (crates/wad-core/src/projects.rs), run as
// WebAssembly; the patterns below are for the UI's inputs and the rules test.

import { call } from "./wasm";

/** The GitHub repository a project is a clone of. */
export interface GitSource {
  kind: "git";
  /** https://github.com/<owner>/<repo>, with or without .git. */
  url: string;
  /** A branch or tag; the default branch when absent. */
  ref?: string;
}

/** A directory on one machine, used where it is. */
export interface FolderSource {
  kind: "folder";
  /** The machine it's on; wadd fills both in for its own machine. */
  machineId: string;
  machineName: string;
  /** Absolute. */
  path: string;
}

/** A filesystem, found by UUID on whichever machine it's plugged into. */
export interface DriveSource {
  kind: "drive";
  uuid: string;
  label: string;
  fstype: string;
  /** Inside the drive, relative; "" is its root. */
  subpath: string;
}

export type ProjectSource = GitSource | FolderSource | DriveSource;
export type SourceKind = ProjectSource["kind"];

export interface Project {
  id: string;
  name: string;
  /** The folder's name on the wadspace's Desktop. */
  mountName: string;
  source: ProjectSource;
  /** Run once in the wadspace (per command), e.g. npm install. Was a repo's postClone. */
  setup: string;
  /** A tombstone: deletions sync, so a deleted project stays as one. */
  deleted: boolean;
  /** Epoch milliseconds. */
  createdAt: number;
  updatedAt: number;
  /** Made before projects had these kinds (an empty folder made by wadd): it
   *  still opens where its folder is, but can't be edited, only deleted. */
  legacy?: boolean;
}

/** What the app edits; the rest the stores keep themselves. No id: a new one. */
export interface ProjectDraft {
  id?: string;
  name: string;
  mountName: string;
  source: ProjectSource;
  setup?: string;
}

/** The clone's state, when the folder is a git checkout. */
export interface GitState {
  branch: string | null;
  /** Uncommitted changes. */
  dirty: boolean;
  /** Commits to push, and commits on the upstream not pulled yet (as of the last fetch). */
  ahead: number;
  behind: number;
  /** e.g. origin/main; null when the branch tracks nothing. */
  upstream: string | null;
}

/** On a machine, with what it says about the folder. */
export interface ProjectStatus {
  existsOnDisk: boolean;
  path: string;
  bytes: number | null;
  /** Workspaces whose unit mounts it. */
  mountedIn: string[];
  /** Whenever the folder is a git checkout (any kind). */
  git: GitState | null;
  /** Can open here: false for a folder on another machine, or a drive that isn't plugged in. */
  available: boolean;
  /** Why not, e.g. "on Surface" or "plug in the drive Photos". */
  reason?: string;
}

/** One of your repositories, as `gh repo list` shows it (wadd/github.py). */
export interface GithubRepo {
  /** owner/name */
  fullName: string;
  name: string;
  private: boolean;
  url: string;
  defaultBranch: string | null;
  /** ISO time of the last push. */
  pushedAt: string | null;
  description: string | null;
}

/** wadd's MOUNT_RE (config.py); "." and ".." aren't allowed either. */
export const MOUNT_RE = /^[A-Za-z0-9._-]{1,64}$/;
export const PROJECT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** wadd's GITHUB_URL_RE (projects.py), and firestore.rules'. */
export const GITHUB_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?(\.git)?$/;
/** A name GitHub takes for a new repository. */
export const REPO_NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;
/** firestore.rules' drive uuid. */
export const DRIVE_UUID_RE = /^[A-Za-z0-9-]{4,64}$/;
export const SOURCE_KINDS: SourceKind[] = ["git", "folder", "drive"];
export const MAX_NAME = 200;
export const MAX_SETUP = 4000;

/** What's wrong with a project, in wadd's terms (it checks the same again). */
export function validateProject(p: ProjectDraft): string[] {
  return call("validateProject", p);
}

/** "https://github.com/you/Notes.git" → "Notes". */
export function repoName(url: string): string {
  return call("repoName", url);
}

/** A GitHub repository's https URL from any way of writing it (https, git@github.com:…,
 *  ssh://git@github.com/…), or null when it isn't one. */
export function githubUrl(url: string): string | null {
  return call("githubUrl", url);
}

/** The same repository, however its URL is written (case, .git, a trailing slash). */
export function sameRepo(a: string, b: string): boolean {
  return call("sameRepo", a, b);
}

/** A folder name made from anything: a project or repo name. */
export function toMountName(s: string): string {
  return call("toMountName", s);
}

/** A folder name for `name` that none of these projects uses yet: Notes, Notes-2, … */
export function freeMountName(projects: Pick<Project, "mountName" | "deleted">[], name: string): string {
  return call("freeMountName", projects, name);
}

/** "https://github.com/you/Notes.git" → "you/Notes"; the URL itself when it isn't GitHub's. */
export function repoFullName(url: string): string {
  return call("repoFullName", url);
}

/** A source as the stores take it: trimmed, and nothing it doesn't use. */
export function cleanSource(s: ProjectSource): ProjectSource {
  return call("cleanSource", s);
}

/** A draft as the stores take it: trimmed, with defaults for what's missing. */
export function cleanDraft(p: ProjectDraft): ProjectDraft {
  return call("cleanDraft", p);
}

/** The last part of a path: "/var/home/wad/Notes" → "Notes". */
export function baseName(path: string): string {
  return call("baseName", path);
}

/** Where a project comes from, in a few words: "you/Notes", "Folder on Surface", "Drive Photos". */
export function sourceLabel(s: ProjectSource): string {
  return call("sourceLabel", s);
}

/** Where on its machine (or drive): a path, or the drive's folder. */
export function sourcePath(s: ProjectSource): string | null {
  return call("sourcePath", s);
}

/** A project for one of your repositories: its name, and a folder named after it. */
export function repoToDraft(repo: Pick<GithubRepo, "name" | "url">): ProjectDraft {
  return call("repoToDraft", repo);
}

/** A stored project as the app shows it. `ms` turns its stored times into
 *  epoch ms (Firestore Timestamps online). One whose source the app doesn't
 *  know (an empty folder from before) is kept, marked legacy, as a folder with no path. */
export function toProjectDoc(id: string, d: Record<string, unknown>, ms: (t: unknown) => number): Project {
  return call("toProjectDoc", id, { ...d, createdAt: ms(d.createdAt), updatedAt: ms(d.updatedAt) });
}

// ------------------------------------------------------- the old repos list
/** A repository a wadspace cloned onto its Desktop at every start, before
 *  projects (`advanced.repos`). Only kept to migrate saved wadspaces and drafts. */
export interface RepoEntry {
  url: string;
  dest: string;
  postClone?: string;
}

/** Legacy repos as project drafts: one per GitHub repository, the Desktop
 *  folder (dest) as both name and folder name, postClone as the setup.
 *  git@github.com: URLs become https ones; anything not on GitHub is dropped. */
export function reposToProjects(repos: RepoEntry[]): ProjectDraft[] {
  return call("reposToProjects", repos);
}

/** The project that's this repository already, if you added it. */
export function projectForRepo(projects: Project[], repo: Pick<GithubRepo, "url">): Project | undefined {
  return call<Project | null>("projectForRepo", projects, repo) ?? undefined;
}

/** The existing project a draft stands for: the same repository, else the same folder name. */
export function findProject(projects: Project[], d: ProjectDraft): Project | undefined {
  return call<Project | null>("findProject", projects, d) ?? undefined;
}
