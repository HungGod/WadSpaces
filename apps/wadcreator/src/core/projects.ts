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
// (legacy/wadd-py/wadd/projects.py) and users/{uid}/projects/{id} in
// Firestore, which wadd's cloud relay syncs both ways (last writer wins on
// updatedAt). wadd's own `synced` and `legacy` flags never leave the machine.
// Shared with the Cloud Functions: no import.meta.env here.

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
const REF_RE = /^[\w./-]{1,200}$/;
/** firestore.rules' drive uuid. */
export const DRIVE_UUID_RE = /^[A-Za-z0-9-]{4,64}$/;
export const SOURCE_KINDS: SourceKind[] = ["git", "folder", "drive"];
export const MAX_NAME = 200;
export const MAX_SETUP = 4000;

/** What's wrong with a project, in wadd's terms (it checks the same again). */
export function validateProject(p: ProjectDraft): string[] {
  const errs: string[] = [];
  const name = p.name.trim();
  if (!name) errs.push("A project needs a name.");
  else if (name.length > MAX_NAME) errs.push(`Keep the name under ${MAX_NAME} characters.`);
  if (!MOUNT_RE.test(p.mountName) || p.mountName === "." || p.mountName === "..") {
    errs.push("The folder name can use letters, digits, dots, dashes and underscores (64 at most).");
  }
  const src = p.source;
  if (src?.kind === "git") {
    if (!GITHUB_URL_RE.test(src.url ?? "")) errs.push("The repository must be https://github.com/<owner>/<repo>.");
    const ref = src.ref;
    if (ref && (!REF_RE.test(ref) || ref.startsWith("-") || ref.includes(".."))) errs.push(`"${ref}" isn't a branch or tag name.`);
  } else if (src?.kind === "folder") {
    if (typeof src.path !== "string" || !src.path.startsWith("/")) errs.push("Pick a folder (a full path).");
  } else if (src?.kind === "drive") {
    if (!DRIVE_UUID_RE.test(src.uuid ?? "")) errs.push("Pick a drive.");
    if (typeof src.subpath !== "string" || src.subpath.startsWith("/") || src.subpath.includes("..")) errs.push("The folder in the drive must be inside it.");
  } else errs.push("A project is a GitHub repository, a folder or a drive.");
  if ((p.setup ?? "").length > MAX_SETUP) errs.push(`Keep the setup command under ${MAX_SETUP} characters.`);
  return errs;
}

/** "https://github.com/you/Notes.git" → "Notes". */
export function repoName(url: string): string {
  return (
    url
      .trim()
      .replace(/\/+$/, "")
      .replace(/\.git$/, "")
      .split(/[/:]/)
      .pop() ?? ""
  );
}

/** A GitHub repository's https URL from any way of writing it (https, git@github.com:…,
 *  ssh://git@github.com/…), or null when it isn't one. */
export function githubUrl(url: string): string | null {
  const u = url
    .trim()
    .replace(/\/+$/, "")
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/^ssh:\/\/git@github\.com(:\d+)?\//, "https://github.com/")
    .replace(/^http:\/\//, "https://");
  return GITHUB_URL_RE.test(u) ? u : null;
}

/** The same repository, however its URL is written (case, .git, a trailing slash). */
export function sameRepo(a: string, b: string): boolean {
  const key = (u: string) => (githubUrl(u) ?? u.trim()).replace(/\.git$/, "").toLowerCase();
  return key(a) === key(b);
}

/** A folder name made from anything: a project or repo name. */
export function toMountName(s: string): string {
  const m = s
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9._-]+/g, "")
    .replace(/^\.+$/, "")
    .slice(0, 64);
  return m || "Project";
}

/** A folder name for `name` that none of these projects uses yet: Notes, Notes-2, … */
export function freeMountName(projects: Pick<Project, "mountName" | "deleted">[], name: string): string {
  const base = toMountName(name);
  const taken = (m: string) => projects.some((p) => !p.deleted && p.mountName === m);
  let mount = base;
  for (let n = 2; taken(mount); n++) mount = `${base.slice(0, 60)}-${n}`;
  return mount;
}

/** "https://github.com/you/Notes.git" → "you/Notes"; the URL itself when it isn't GitHub's. */
export function repoFullName(url: string): string {
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(\.git)?\/?$/.exec(url.trim());
  return m ? m[1] : url;
}

/** A source as the stores take it: trimmed, and nothing it doesn't use. */
export function cleanSource(s: ProjectSource): ProjectSource {
  switch (s.kind) {
    case "git": {
      const ref = s.ref?.trim();
      return { kind: "git", url: (s.url ?? "").trim(), ...(ref && { ref }) };
    }
    case "folder":
      return { kind: "folder", machineId: s.machineId ?? "", machineName: s.machineName ?? "", path: (s.path ?? "").trim() };
    case "drive":
      return { kind: "drive", uuid: s.uuid, label: s.label ?? "", fstype: s.fstype ?? "", subpath: (s.subpath ?? "").replace(/^\/+|\/+$/g, "") };
  }
}

/** A draft as the stores take it: trimmed, with defaults for what's missing. */
export function cleanDraft(p: ProjectDraft): ProjectDraft {
  return {
    ...(p.id && { id: p.id }),
    name: p.name.trim(),
    mountName: p.mountName.trim(),
    source: cleanSource(p.source),
    setup: (p.setup ?? "").trim(),
  };
}

/** The last part of a path: "/var/home/wad/Notes" → "Notes". */
export function baseName(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() ?? "";
}

/** Where a project comes from, in a few words: "you/Notes", "Folder on Surface", "Drive Photos". */
export function sourceLabel(s: ProjectSource): string {
  switch (s.kind) {
    case "git":
      return repoFullName(s.url);
    case "folder":
      return s.machineName ? `Folder on ${s.machineName}` : "Folder";
    case "drive":
      return `Drive ${s.label || s.uuid}`;
  }
}

/** Where on its machine (or drive): a path, or the drive's folder. */
export function sourcePath(s: ProjectSource): string | null {
  if (s.kind === "folder") return s.path;
  if (s.kind === "drive") return s.subpath ? `/${s.subpath}` : "/";
  return null;
}

/** A project for one of your repositories: its name, and a folder named after it. */
export function repoToDraft(repo: Pick<GithubRepo, "name" | "url">): ProjectDraft {
  return { name: repo.name, mountName: toMountName(repo.name), source: { kind: "git", url: repo.url }, setup: "" };
}

/** A stored source the app knows, or null (an old kind, or one that's broken). */
function knownSource(raw: unknown): ProjectSource | null {
  const s = (raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  if (s.kind === "git" && GITHUB_URL_RE.test(str(s.url))) return { kind: "git", url: str(s.url), ...(str(s.ref) && { ref: str(s.ref) }) };
  if (s.kind === "folder" && str(s.path).startsWith("/")) return { kind: "folder", machineId: str(s.machineId), machineName: str(s.machineName), path: str(s.path) };
  if (s.kind === "drive" && DRIVE_UUID_RE.test(str(s.uuid))) return { kind: "drive", uuid: str(s.uuid), label: str(s.label), fstype: str(s.fstype), subpath: str(s.subpath) };
  return null;
}

/** A stored project as the app shows it. One whose source the app doesn't
 *  know (an empty folder from before) is kept, marked legacy, as a folder with no path. */
export function toProjectDoc(id: string, d: Record<string, unknown>, ms: (t: unknown) => number): Project {
  const source = knownSource(d.source);
  return {
    id,
    name: (d.name as string) ?? id,
    mountName: (d.mountName as string) ?? "",
    source: source ?? { kind: "folder", machineId: "", machineName: "", path: "" },
    setup: (d.setup as string) ?? "",
    deleted: !!d.deleted,
    createdAt: ms(d.createdAt),
    updatedAt: ms(d.updatedAt),
    ...((!source || d.legacy === true) && { legacy: true }),
  };
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
  const out: ProjectDraft[] = [];
  const mounts = new Set<string>();
  for (const r of repos) {
    const url = githubUrl(r.url ?? "");
    if (!url || out.some((p) => p.source.kind === "git" && sameRepo(p.source.url, url))) continue;
    const name = r.dest?.trim() || repoName(url) || "Project";
    let mount = toMountName(name);
    for (let n = 2; mounts.has(mount); n++) mount = `${toMountName(name).slice(0, 60)}-${n}`;
    mounts.add(mount);
    out.push({ name, mountName: mount, source: { kind: "git", url }, setup: r.postClone?.trim() ?? "" });
  }
  return out;
}

/** The project that's this repository already, if you added it. */
export function projectForRepo(projects: Project[], repo: Pick<GithubRepo, "url">): Project | undefined {
  return projects.find((p) => !p.deleted && !p.legacy && p.source.kind === "git" && !!repo.url && sameRepo(p.source.url, repo.url));
}

/** The existing project a draft stands for: the same repository, else the same folder name. */
export function findProject(projects: Project[], d: ProjectDraft): Project | undefined {
  const live = projects.filter((p) => !p.deleted);
  return (d.source.kind === "git" ? projectForRepo(live, d.source) : undefined) ?? live.find((p) => p.mountName === d.mountName);
}
