// Client for wadd, the daemon on this machine (legacy/wadd-py/wadd/api.py).
// The offline app talks to it directly on 127.0.0.1:8080 from the origin
// app://wadcreator, which wadd trusts for changes. The online app never does:
// it reaches machines through the cloud relay (relay.ts).

import { useEffect, useState } from "react";
import type { GithubRepo, Project, ProjectDraft } from "@core/projects";
import type { WaddSpec } from "@core/spec";
import type { TailnetStatus } from "./types";

export const WADD_URL: string = import.meta.env.VITE_WADD_URL || "http://127.0.0.1:8080";

/** While an image downloads (wadd/registry.py PullProgress). total_bytes is
 *  null when the registry sizes are unknown: show an indeterminate bar. */
export interface Download {
  total_bytes: number | null;
  done_bytes: number;
  layers: number;
  rate_bps: number;
  eta_s: number | null;
  unpacking: boolean;
}

export interface WorkspaceState {
  container: string;
  phase: "idle" | "pulling" | "starting" | "waiting" | "ready" | "stopping" | "error";
  progress: number | null;
  message: string | null;
  error: string | null;
  image_present: boolean | null;
  download: Download | null;
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
  state: WorkspaceState;
}

export interface Snapshot {
  machine: string;
  version: string;
  view: string;
  /** Linked to an account through the cloud relay. */
  enrolled?: boolean;
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

// A session, started from the machine's Home screen or from Wad Creator.
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
}

/** A `build` event, or GET /api/builds/{id}: the job plus log lines from line `from`. */
export interface BuildUpdate extends BuildSummary {
  from: number;
  lines: string[];
}

/** A launch on this machine (wadd/launches.py): the image and projects, then the start. */
export interface LaunchSummary {
  id: string;
  wsId: string;
  name: string;
  projects: string[];
  view: "screen" | "stream";
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

async function call<T>(method: string, path: string, body?: unknown, raw?: { data: Uint8Array; type: string }): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`${WADD_URL}${path}`, {
      method,
      headers: raw ? { "Content-Type": raw.type } : body === undefined ? {} : { "Content-Type": "application/json" },
      body: raw ? (raw.data as BodyInit) : body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    const message = `Cannot reach wadd at ${WADD_URL}. Is this a WadSpaces machine?`;
    recordFailure({ time: Date.now(), method, path, status: 0, message });
    throw new WaddError(message, 0);
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const detail = (data as { detail?: unknown }).detail;
    const message = typeof detail === "string" ? detail : r.statusText;
    recordFailure({ time: Date.now(), method, path, status: r.status, message });
    throw new WaddError(message, r.status);
  }
  return data as T;
}

export const wadd = {
  health: () => call<{ ok: boolean; version: string }>("GET", "/api/health"),
  status: () => call<Omit<Snapshot, "workspaces">>("GET", "/api/status"),
  workspaces: () => call<MachineWorkspace[]>("GET", "/api/workspaces"),
  specs: () => call<WaddSpec[]>("GET", "/api/specs"),
  spec: (id: string) => call<WaddSpec>("GET", `/api/specs/${encodeURIComponent(id)}`),
  action: (id: string, action: "switch" | "start" | "stop" | "restart" | "download") =>
    call<{ ok: boolean }>("POST", `/api/workspaces/${encodeURIComponent(id)}/${action}`),
  launcher: () => call("POST", "/api/launcher"),
  /** Start a focus session: the machine locks to these workspaces until time's up. */
  session: (workspaces: string[], minutes: number) => call<Session>("POST", "/api/session", { workspaces, minutes }),
  enroll: (code: string) => call<{ ok: boolean; machineId: string }>("POST", "/api/enroll", { code }),
  create: (spec: WaddSpec) => call<WaddSpec>("POST", "/api/workspaces", spec),
  update: (id: string, spec: WaddSpec) =>
    call<{ workspace: WaddSpec; restart_required: boolean }>("PUT", `/api/workspaces/${encodeURIComponent(id)}`, spec),
  remove: (id: string) => call("DELETE", `/api/workspaces/${encodeURIComponent(id)}`),
  diagnostics: () => call<Diagnostics>("GET", "/api/diagnostics"),
  // Builds on this machine
  builds: () => call<BuildSummary[]>("GET", "/api/builds"),
  createBuild: (workspace: WaddSpec, baseImage: string) => call<BuildSummary>("POST", "/api/builds", { workspace, base_image: baseImage }),
  buildContext: (id: string, tarball: Uint8Array) =>
    call<BuildSummary>("PUT", `/api/builds/${encodeURIComponent(id)}/context`, undefined, { data: tarball, type: "application/x-tar" }),
  build: (id: string, since = 0) => call<BuildUpdate>("GET", `/api/builds/${encodeURIComponent(id)}?since=${since}`),
  cancelBuild: (id: string) => call<BuildSummary>("DELETE", `/api/builds/${encodeURIComponent(id)}`),
  // Projects (folders mounted at launch) and launches
  projects: () => call<WaddProject[]>("GET", "/api/projects"),
  createProject: (p: ProjectDraft) => call<WaddProject>("POST", "/api/projects", p),
  putProject: (id: string, p: ProjectDraft) => call<WaddProject>("PUT", `/api/projects/${encodeURIComponent(id)}`, p),
  deleteProject: (id: string, purge = false) =>
    call<WaddProject & { purged: boolean }>("DELETE", `/api/projects/${encodeURIComponent(id)}${purge ? "?purge=1" : ""}`),
  projectStatus: (id: string) => call<WaddProjectStatus>("GET", `/api/projects/${encodeURIComponent(id)}/status`),
  // GitHub, with the machine's github_token (wadd/github.py)
  github: () => call<{ token: boolean; login: string | null; error?: string }>("GET", "/api/github"),
  /** 409: no github_token; 502: GitHub said no. */
  githubRepos: () => call<{ login: string | null; repos: GithubRepo[] }>("GET", "/api/github/repos"),
  createGithubRepo: (body: { name: string; private?: boolean; description?: string; mountName?: string; setup?: string }) =>
    call<WaddProject>("POST", "/api/github/repos", body),
  // Folders and drives on this machine, for folder and drive projects
  drives: () => call<WaddDrive[]>("GET", "/api/drives"),
  /** 403 outside the folders wadd lets you pick from. */
  browse: (q: { path?: string; drive?: string }) => {
    const qs = new URLSearchParams();
    if (q.drive) qs.set("drive", q.drive);
    if (q.path) qs.set("path", q.path);
    const s = qs.toString();
    return call<WaddListing>("GET", `/api/fs/browse${s ? `?${s}` : ""}`);
  },
  // Tailscale on this machine (wadd/tailnet.py)
  tailnet: () => call<TailnetStatus>("GET", "/api/tailnet"),
  tailnetLogin: () => call<{ url: string | null; online?: boolean }>("POST", "/api/tailnet/login"),
  tailnetLogout: () => call<{ ok: boolean }>("POST", "/api/tailnet/logout"),
  launches: () => call<LaunchSummary[]>("GET", "/api/launches"),
  createLaunch: (body: { workspace: string; projects: string[]; view?: "screen" | "stream"; restart?: boolean }) =>
    call<LaunchSummary>("POST", "/api/launches", body),
  launch: (id: string, since = 0) => call<LaunchUpdate>("GET", `/api/launches/${encodeURIComponent(id)}?since=${since}`),
  cancelLaunch: (id: string) => call<LaunchSummary>("DELETE", `/api/launches/${encodeURIComponent(id)}`),
  // Wad Creator's library, kept by wadd
  library: <T,>(collection: "wadspaces" | "drafts") => call<T[]>("GET", `/api/library/${collection}`),
  libraryPut: <T,>(collection: "wadspaces" | "drafts", id: string, doc: T) => call<T>("PUT", `/api/library/${collection}/${encodeURIComponent(id)}`, doc),
  libraryDelete: (collection: "wadspaces" | "drafts", id: string) => call("DELETE", `/api/library/${collection}/${encodeURIComponent(id)}`),
  // Load and history
  metrics: () => call<Metrics>("GET", "/api/metrics"),
  runs: (workspace?: string, limit = 200) =>
    call<RunRecord[]>("GET", `/api/runs?limit=${limit}${workspace ? `&workspace=${encodeURIComponent(workspace)}` : ""}`),
  /** Which of the newer endpoints this wadd has (older ones on a stick predate builds). */
  features: async () => {
    const has = async (path: string) => {
      try {
        const r = await fetch(`${WADD_URL}${path}`);
        return r.ok;
      } catch {
        return false;
      }
    };
    // Tailscale's status too: whether it's installed decides the Tailnet card.
    const tailnet = async (): Promise<TailnetStatus | null> => {
      try {
        const r = await fetch(`${WADD_URL}/api/tailnet`);
        return r.ok ? ((await r.json()) as TailnetStatus) : null;
      } catch {
        return null;
      }
    };
    const [builds, library, runs, projects, tailnetStatus] = await Promise.all([
      has("/api/builds"),
      has("/api/library/drafts"),
      has("/api/runs?limit=1"),
      has("/api/projects"),
      tailnet(),
    ]);
    return { builds, library, runs, projects, tailnet: tailnetStatus };
  },
  daemonLog: (lines = 200) => call<{ lines: LogLine[] }>("GET", `/api/logs/daemon?lines=${lines}`),
  unitLog: (unit: string, lines = 200) =>
    call<{ text: string }>("GET", `/api/logs/unit/${encodeURIComponent(unit)}?lines=${lines}`),
  workspaceLog: (id: string, lines = 200) =>
    call<{ text: string }>("GET", `/api/logs/workspace/${encodeURIComponent(id)}?lines=${lines}`),
};

// ------------------------------------------------------------ formatting
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

/** "1.9 GB of 5.3 GB · 12.0 MB/s · about 4 min left" (matches wadd's). */
export function downloadLabel(d: Download | null): string {
  if (!d) return "";
  if (d.total_bytes == null) return d.layers ? `downloading ${d.layers} layers` : "downloading";
  if (d.total_bytes === 0) return "already downloaded, unpacking";
  if (d.unpacking) return `downloaded ${formatBytes(d.done_bytes)}, unpacking`;
  const bits = [`${formatBytes(d.done_bytes)} of ${formatBytes(d.total_bytes)}`];
  if (d.rate_bps >= 1000) bits.push(`${formatBytes(d.rate_bps)}/s`);
  if (d.eta_s != null) bits.push(`about ${formatDuration(d.eta_s)} left`);
  return bits.join(" · ");
}

/** Live machine snapshot from wadd's server-sent events. */
export function useMachine(): { snap: Snapshot | null; error: string | null } {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    const connect = () => {
      es = new EventSource(`${WADD_URL}/api/events`);
      es.addEventListener("state", (e) => {
        setSnap(JSON.parse((e as MessageEvent).data));
        setError(null);
      });
      es.onerror = () => {
        es?.close();
        if (closed) return;
        setError(`Cannot reach wadd at ${WADD_URL}.`);
        retry = setTimeout(connect, 3000);
      };
    };
    connect();
    return () => {
      closed = true;
      es?.close();
      clearTimeout(retry);
    };
  }, []);
  return { snap, error };
}
