// Client for wadd, the daemon on this machine (apps/wadd). Every call goes
// through the app's Rust side (src-tauri/src/wadd.rs), so only the machine
// app (Tauri) reaches it. The older calls keep their /api shapes, which
// src-tauri/src/rswadd.rs turns into wadd's /v1. The online app never calls
// wadd: it reaches machines through the cloud relay (relay.ts).

import type { GithubRepo, Project, ProjectDraft } from "@core/projects";
import { inTauri } from "./shell";
import type { TailnetStatus } from "./types";
import type { ImageRow } from "@/data/layers";

export interface WorkspaceState {
  container: string;
  phase: "idle" | "starting" | "waiting" | "ready" | "stopping" | "error";
  message: string | null;
  error: string | null;
  image_present: boolean | null;
  since: number;
}

export interface MachineWorkspace {
  id: string;
  name: string;
  port: number | null;
  url: string | null; // null for a native workspace: no stream
  display: "stream" | "host";
  hotkey: number | null;
  icon: string | null;
  enabled: boolean;
  image: string;
  /** "app": a program on the machine (Terminal, WadBrowser), not an image. */
  kind?: "app" | null;
  state: WorkspaceState;
}

export interface Snapshot {
  machine: string;
  version: string;
  view: string;
  /** Linked to an account through the cloud relay. */
  enrolled?: boolean;
  /** This machine's id in the account, and the account's uid (null until linked). */
  machine_id?: string | null;
  owner_uid?: string | null;
  cloud_enabled?: boolean;
  kiosk_connected: boolean;
  backend: string;
  backend_connected: boolean;
  hotkey_devices: number;
  pending: string | null;
  network: NetworkStatus;
  session: Session | null;
  native_display: boolean;
  workspaces: MachineWorkspace[];
}

// A session, started from the machine's Home screen or from the WadSpaces Client.
// Times are epoch seconds. A focus session's clock starts the first time one
// of its workspaces is on screen, so ends_at stays null until then.
export interface Session {
  workspaces: string[];
  mode: "focus" | "free";
  started_at: number;
  minutes?: number;
  ends_at: number | null;
  expired: boolean;
  remaining_s: number | null;
}

export interface NetworkStatus {
  available?: boolean;
  state?: string;
  connectivity?: string;
  ssid?: string | null;
  signal?: number | null;
  error?: string;
}

/** GET /api/network/wifi: one network in range (wadd/network.py). */
export interface WifiNetwork {
  ssid: string;
  signal: number;
  security: string;
  secure: boolean;
  /** WPA personal or open: enterprise and WEP networks can't be joined here. */
  supported: boolean;
  active: boolean;
  /** Saved: joins without asking for the password again. */
  known: boolean;
}

export interface LogLine {
  time: number;
  level: string;
  logger: string;
  message: string;
}

export interface Diagnostics {
  wadd: { version: string; uptime_s: number; pid: number; config: string | null; backend: string };
  podman: { connected: boolean; version?: string; graph_root?: string; storage_driver?: string; images?: number; error?: string };
  disk: { path: string; free_bytes: number; total_bytes: number };
  network: NetworkStatus;
  kiosk: { connected: boolean; view: string; pending: string | null };
  keyboards: string[];
  secrets: string[];
  log_units: string[];
  workspaces: (WorkspaceState & { id: string; name: string; image: string; enabled: boolean })[];
  recent_problems: LogLine[];
}

/** A build on this machine (wadd/builds.py). */
export interface BuildSummary {
  id: string;
  wsId: string;
  name: string;
  status: "waiting" | "queued" | "building" | "done" | "error" | "cancelled";
  progress: number;
  error: string | null;
  image: string;
  created: number;
  started: number | null;
  finished: number | null;
  /** Rebuilt an existing workspace (vs. added a new one). */
  installed: boolean;
  restartRequired: boolean;
  lineCount: number;
  /** A layer's build ("template:<id>" / "custom:<id>"); null: a design's. */
  layer?: string | null;
}

/** A `build` event, or GET /api/builds/{id}: the job plus log lines from line `from`. */
export interface BuildUpdate extends BuildSummary {
  from: number;
  lines: string[];
}

/** A launch on this machine: the image and the copies it takes in, then the start. */
export interface LaunchSummary {
  id: string;
  wsId: string;
  name: string;
  /** What a launch mounted, from before projects were cloned and copied in (none now). */
  projects?: string[];
  restart: boolean;
  status: "queued" | "running" | "done" | "error" | "cancelled";
  progress: number;
  phase: string;
  error: string | null;
  parts: {
    key: string;
    kind: "image" | "project";
    name: string;
    state: "waiting" | "working" | "done" | "error";
    progress: number | null;
    message: string | null;
  }[];
  created: number;
  started: number | null;
  finished: number | null;
  lineCount: number;
}

/** A `launch` event, or GET /api/launches/{id}: the job plus log lines from line `from`. */
export interface LaunchUpdate extends LaunchSummary {
  from: number;
  lines: string[];
}

/** A project document as wadd keeps it; `synced` and `legacy` never leave the machine. */
export type WaddProject = Project & { synced?: boolean };

export interface WaddProjectStatus {
  exists_on_disk: boolean;
  path: string;
  bytes: number | null;
  mounted_in: string[];
  /** Null when the folder isn't there or isn't a git checkout. */
  git?: { branch: string | null; dirty: boolean; ahead: number; behind: number; upstream: string | null } | null;
  /** False for a folder on another machine, or a drive that isn't plugged in; `reason` says which. */
  available?: boolean;
  reason?: string;
}

/** A saved sign-in on this machine (wadd's signins): mounted into each
 *  wadspace whose apps use it, so signing in once covers all of them. */
export interface WaddSignIn {
  id: string;
  name: string;
  /** "web" (a WadBrowser profile, for any web app) or the app whose files it keeps. */
  app: string;
  /** Those files, under the home folder (a folder's ends in /); none for "web". */
  paths: string[];
  createdAt: number;
  /** What's saved, in bytes. */
  size: number;
  /** When anything in it last changed (ms); null while it's empty. */
  changedAt: number | null;
  /** Wadspaces here that mount it, and those of them running. */
  usedBy: string[];
  inUse: string[];
}

/** A podman secret's name and where it came from (GET /v1/secrets). */
export interface WaddSecret {
  name: string;
  origin: "account" | "local" | "placeholder";
}

/** GET /api/drives */
export interface WaddDrive {
  uuid: string;
  label: string | null;
  fstype: string;
  size: number | null;
  mountpoint: string | null;
  removable: boolean;
  model: string | null;
}

/** GET /api/fs/browse */
export interface WaddListing {
  path: string | null;
  parent: string | null;
  dirs: { name: string; path: string }[];
  /** Its files, when asked for. */
  files?: { name: string; path: string }[];
}

export interface Metrics {
  cpu: number;
  mem: number;
  memUsed: number;
  memTotal: number;
  diskFree: number;
  diskTotal: number;
  load: number;
  gpu: string;
}

export interface RunRecord {
  id: string;
  wadspaceId: string;
  wadspaceName: string;
  mode: "local" | "stream";
  user: string;
  /** Ids of the projects the run mounted (newer wadd). */
  projects?: string[];
  startedAt: number;
  endedAt: number | null;
}

/** Failed calls to wadd, newest first, for the Diagnostics page. */
export interface ApiFailure {
  time: number;
  method: string;
  path: string;
  status: number;
  message: string;
}
const failures: ApiFailure[] = [];
const failureListeners = new Set<() => void>();
export function apiFailures(): ApiFailure[] {
  return failures;
}
export function onApiFailure(fn: () => void): () => void {
  failureListeners.add(fn);
  return () => failureListeners.delete(fn);
}
function recordFailure(f: ApiFailure) {
  failures.unshift(f);
  failures.length = Math.min(failures.length, 20);
  failureListeners.forEach((fn) => fn());
}

export class WaddError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

type Method = "GET" | "POST" | "PUT" | "DELETE";

/** Through the app's Rust side; it rejects with { status, message }. */
async function callApp<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const { commands } = await import("@/gen/bindings");
  try {
    return (await commands.waddRequest(method, path, body ?? null)) as T;
  } catch (e) {
    const f = e as { status?: number; message?: string };
    const message = f.message ?? String(e);
    const status = f.status ?? 0;
    recordFailure({ time: Date.now(), method, path, status, message });
    throw new WaddError(message, status);
  }
}

async function call<T>(method: Method, path: string, body?: unknown): Promise<T> {
  if (inTauri) return callApp<T>(method, path, body);
  const message = "wadd is reached through the WadSpaces app (npm run app:offline), not a browser.";
  recordFailure({ time: Date.now(), method, path, status: 0, message });
  throw new WaddError(message, 0);
}

export const wadd = {
  action: (id: string, action: "switch" | "start" | "stop" | "restart") =>
    call<{ ok: boolean }>("POST", `/api/workspaces/${encodeURIComponent(id)}/${action}`),
  launcher: () => call("POST", "/api/launcher"),
  /** End the session; `force` ends a focus session before its time is up. */
  endSession: (force = false) => call<{ ok: boolean }>("POST", "/api/session/end", force ? { force: true } : undefined),
  enroll: (code: string) => call<{ ok: boolean; machineId: string }>("POST", "/api/enroll", { code }),
  remove: (id: string) => call("DELETE", `/api/workspaces/${encodeURIComponent(id)}`),
  diagnostics: () => call<Diagnostics>("GET", "/api/diagnostics"),
  // Wi-Fi and power (the machine app's menus)
  wifiScan: () => call<WifiNetwork[]>("GET", "/api/network/wifi"),
  wifiConnect: (ssid: string, password?: string) => call<{ ok: boolean }>("POST", "/api/network/wifi/connect", { ssid, ...(password && { password }) }),
  wifiDisconnect: () => call<{ ok: boolean }>("POST", "/api/network/wifi/disconnect"),
  power: (action: "poweroff" | "reboot") => call<{ ok: boolean }>("POST", "/api/power", { action }),

  /** The HUD's menu was closed: wadd puts back what was on screen. */
  hudClosed: () => call<{ ok: boolean }>("POST", "/api/hud/closed"),
  // Builds on this machine
  builds: () => call<BuildSummary[]>("GET", "/api/builds"),
  build: (id: string, since = 0) => call<BuildUpdate>("GET", `/api/builds/${encodeURIComponent(id)}?since=${since}`),
  cancelBuild: (id: string) => call<BuildSummary>("DELETE", `/api/builds/${encodeURIComponent(id)}`),
  // Projects (folders mounted at launch) and launches
  projects: () => call<WaddProject[]>("GET", "/api/projects"),
  createProject: (p: ProjectDraft) => call<WaddProject>("POST", "/api/projects", p),
  putProject: (id: string, p: ProjectDraft) => call<WaddProject>("PUT", `/api/projects/${encodeURIComponent(id)}`, p),
  deleteProject: (id: string, purge = false) =>
    call<WaddProject & { purged: boolean }>("DELETE", `/api/projects/${encodeURIComponent(id)}${purge ? "?purge=1" : ""}`),
  projectStatus: (id: string) => call<WaddProjectStatus>("GET", `/api/projects/${encodeURIComponent(id)}/status`),
  // Saved sign-ins, mounted into the wadspaces that use them
  signIns: () => call<WaddSignIn[]>("GET", "/api/signins"),
  createSignIn: (body: { name: string; app: string; paths?: string[] }) => call<WaddSignIn>("POST", "/api/signins", body),
  patchSignIn: (id: string, body: { name?: string; paths?: string[] }) =>
    call<WaddSignIn>("PUT", `/api/signins/${encodeURIComponent(id)}`, body),
  /** 409 while a running wadspace uses it. */
  signOut: (id: string) => call<WaddSignIn>("POST", `/api/signins/${encodeURIComponent(id)}/signout`),
  /** 409 while a wadspace here uses it. */
  deleteSignIn: (id: string) => call("DELETE", `/api/signins/${encodeURIComponent(id)}`),
  /** The machine's secrets (names and origins; never values). */
  secretList: () => call<WaddSecret[]>("GET", "/api/secrets/list"),
  // GitHub, with the machine's github_token (wadd/github.py)
  github: () => call<{ token: boolean; login: string | null; error?: string }>("GET", "/api/github"),
  /** 409: no github_token; 502: GitHub said no. */
  githubRepos: () => call<{ login: string | null; repos: GithubRepo[] }>("GET", "/api/github/repos"),
  createGithubRepo: (body: { name: string; private?: boolean; description?: string; mountName?: string; setup?: string }) =>
    call<WaddProject>("POST", "/api/github/repos", body),
  // Folders and drives on this machine, for folder and drive projects
  drives: () => call<WaddDrive[]>("GET", "/api/drives"),
  /** 403 outside the folders wadd lets you pick from. `files`: its files too. */
  browse: (q: { path?: string; drive?: string; files?: boolean }) => {
    const qs = new URLSearchParams();
    if (q.drive) qs.set("drive", q.drive);
    if (q.path) qs.set("path", q.path);
    if (q.files) qs.set("files", "true");
    const s = qs.toString();
    return call<WaddListing>("GET", `/api/fs/browse${s ? `?${s}` : ""}`);
  },
  /** A copy of files on this machine for wadspaces to take in: one folder's contents, or each path by name. */
  makeCopy: (paths: string[]) => call<{ id: string; files: number; bytes: number }>("POST", "/api/copies", { paths }),
  /** Refused (409) while a wadspace here has it. */
  deleteCopy: (id: string) => call("DELETE", `/api/copies/${encodeURIComponent(id)}`),
  /** What WadSpaces takes on this machine's disk (wadd measures at most once a minute; `fresh` now). */
  storage: (fresh = false) => call<Storage>("GET", `/v1/storage${fresh ? "?fresh=true" : ""}`),
  // Tailscale on this machine (wadd/tailnet.py)
  tailnet: () => call<TailnetStatus>("GET", "/api/tailnet"),
  tailnetLogin: () => call<{ url: string | null; online?: boolean }>("POST", "/api/tailnet/login"),
  tailnetLogout: () => call<{ ok: boolean }>("POST", "/api/tailnet/logout"),
  launches: () => call<LaunchSummary[]>("GET", "/api/launches"),
  launch: (id: string, since = 0) => call<LaunchUpdate>("GET", `/api/launches/${encodeURIComponent(id)}?since=${since}`),
  cancelLaunch: (id: string) => call<LaunchSummary>("DELETE", `/api/launches/${encodeURIComponent(id)}`),
  // The WadSpaces Client's library, kept by wadd
  library: <T,>(collection: LibraryCollection) => call<T[]>("GET", `/api/library/${collection}`),
  libraryPut: <T,>(collection: LibraryCollection, id: string, doc: T) => call<T>("PUT", `/api/library/${collection}/${encodeURIComponent(id)}`, doc),
  libraryDelete: (collection: LibraryCollection, id: string) => call("DELETE", `/api/library/${collection}/${encodeURIComponent(id)}`),
  // The Builder's layers (wadd's /v1, passed through as it is)
  /** The layer images here. */
  images: () => call<ImageRow[]>("GET", "/v1/images"),
  /** Builds a layer's image (its template first when needed). */
  buildLayer: (req: { layer: string; template: unknown; parents: unknown[]; extensions: unknown }) => call<{ id: string }>("POST", "/v1/images/build", req),
  deleteImage: (layer: string) => call("DELETE", `/v1/images/${encodeURIComponent(layer)}`),
  /** Installs (or updates) a wadspace as a workspace on its layer's image. */
  installWadspace: (id: string, body: unknown) => call<{ restartRequired: boolean }>("PUT", `/v1/wadspaces/${encodeURIComponent(id)}`, body),
  /** The wallpaper a wadspace starts with (drawn here). */
  putWallpaper: (id: string, up: { ext: "png" | "jpg"; data: string }) => call("PUT", `/v1/workspaces/${encodeURIComponent(id)}/wallpaper`, up),
  /** The launcher's pick, launched together: the workspaces' ids. */
  launchBatch: (items: unknown[], focusMinutes: number | null) => call<string[]>("POST", "/v1/launches/batch", { items, focusMinutes }),
  /** This machine: its name, and its screen's logical size. */
  machine: () => call<{ name: string; screen: { width: number; height: number; scale: number } | null }>("GET", "/v1/machine"),
  // Load and history
  metrics: () => call<Metrics>("GET", "/api/metrics"),
  runs: (workspace?: string, limit = 200) =>
    call<RunRecord[]>("GET", `/api/runs?limit=${limit}${workspace ? `&workspace=${encodeURIComponent(workspace)}` : ""}`),
  /** Which of wadd's endpoints answer, and Tailscale's status. */
  features: async () => {
    // Probes, so they stay out of the failures list (call() would record them).
    const get = async (path: string): Promise<unknown> => {
      if (!inTauri) throw new Error("not in the app");
      const { commands } = await import("@/gen/bindings");
      return commands.waddRequest("GET", path, null);
    };
    const has = (path: string) => get(path).then(() => true, () => false);
    // Tailscale's status too: whether it's installed decides the Tailnet card.
    const tailnet = () => get("/api/tailnet").then((t) => t as TailnetStatus, () => null);
    const [builds, layers, library, runs, projects, signins, tailnetStatus] = await Promise.all([
      has("/api/builds"),
      has("/v1/images"),
      has("/api/library/drafts"),
      has("/api/runs?limit=1"),
      has("/api/projects"),
      has("/api/signins"),
      tailnet(),
    ]);
    return { builds, layers, library, runs, projects, signins, tailnet: tailnetStatus };
  },
  daemonLog: (lines = 200) => call<{ lines: LogLine[] }>("GET", `/api/logs/daemon?lines=${lines}`),
  unitLog: (unit: string, lines = 200) =>
    call<{ text: string }>("GET", `/api/logs/unit/${encodeURIComponent(unit)}?lines=${lines}`),
  workspaceLog: (id: string, lines = 200) =>
    call<{ text: string }>("GET", `/api/logs/workspace/${encodeURIComponent(id)}?lines=${lines}`),
};

/** The library's collections in wadd (`/v1/library/{collection}`). */
export type LibraryCollection = "wadspaces" | "templates" | "extensions" | "customizations" | "browsers" | "meta";

/** wadd's event stream (`state`, `build`, `launch`, …): `on(event, data)` for
 *  each one, `onDrop()` when the stream drops (it reconnects by itself).
 *  Returns a function that stops listening. */
export function waddEvents(on: (event: string, data: unknown) => void, onDrop: () => void): () => void {
  if (inTauri) {
    let stop: (() => void) | null = null;
    let stopped = false;
    void (async () => {
      const { commands, events } = await import("@/gen/bindings");
      const unlisten = await events.waddEvent.listen(({ payload }) =>
        payload.event === "disconnected" ? onDrop() : on(payload.event, payload.data),
      );
      if (stopped) return unlisten();
      stop = unlisten;
      // The app has been following the stream since it started: catch up.
      const last = await commands.waddLastState();
      if (last != null) on("state", last);
    })();
    return () => {
      stopped = true;
      stop?.();
    };
  }
  // In a browser there's no wadd to follow.
  onDrop();
  return () => {};
}

// ------------------------------------------------------------ formatting
/** GET /v1/storage (wad-proto's Storage). */
export interface Storage {
  disk: { path: string; freeBytes: number; totalBytes: number };
  /** The base every template builds on; null if it isn't here. */
  base: { ref: string; id: string; bytes: number } | null;
  /** Each layer image: all of it, and its own share (what it adds to the image it's built on). */
  layers: { layer: string; id: string; from: string; bytes: number; ownBytes: number }[];
  /** Each wadspace's home (its /config). */
  homes: { workspaceId: string; volume: string; bytes: number }[];
  /** Files copied in for wadspaces. */
  copies: { id: string; bytes: number }[];
  measuredAt: number;
}

export function formatBytes(n: number): string {
  if (n < 1000) return `${Math.round(n)} B`;
  if (n < 1e6) return `${Math.round(n / 1e3)} KB`;
  if (n < 1e9) return `${(n / 1e6).toFixed(1)} MB`;
  return `${(n / 1e9).toFixed(1)} GB`;
}

export function formatDuration(s: number): string {
  if (s < 90) return `${Math.max(1, Math.round(s))} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  return `${(s / 3600).toFixed(1)} h`;
}
