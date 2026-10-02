import { create } from "zustand";
import { backend, type Topic } from "@/data";
import type { BuildProgress, LaunchProgress, WadspacePatch } from "@/data/backend";
import type { Project } from "@core/projects";
import type { BuildJob } from "./build";
import type { LaunchJob } from "./launch";
import { THIS_MACHINE, hasAccount } from "./machine";
import type { App, Draft, FocusLock, LastSession, Machine, PublicUser, Wadspace } from "./types";

/** The machine the offline app runs on. */
export { THIS_MACHINE } from "./machine";

interface Toast {
  id: number;
  title: string;
  body?: string;
  tone?: "default" | "success" | "error";
  progress?: number; // 0..1 when showing a progress toast
  action?: { label: string; onClick: () => void };
}

/** A wadspace image downloading to the launch-target machine. */
export interface Download {
  wadspaceId: string;
  name: string;
  sizeMB: number;
  progress: number; // 0..1; 0 while the size isn't known
  label?: string;
}

interface AppState {
  user: PublicUser | null;
  users: PublicUser[];
  wadspaces: Wadspace[];
  machines: Machine[];
  apps: App[];
  drafts: Draft[];
  focus: FocusLock | null;
  lastSession: LastSession | null;
  /** serverNow - clientNow, so countdowns agree with the server clock. */
  clockSkew: number;
  launchTarget: string;
  toasts: Toast[];
  downloads: Download[];
  /** The wadspace whose "while you wait" sheet is open. */
  waitingFor: string | null;
  builds: BuildJob[];
  /** The build whose log is open. */
  buildLog: string | null;
  /** The user's projects (none deleted), by name. */
  projects: Project[];
  /** Wadspaces getting their image and projects ready, then starting (offline). */
  launches: LaunchJob[];
  /** Quiet notices that surface from the profile icon, e.g. "your wadspace is ready". */
  notices: Notice[];

  setUser: (u: PublicUser | null) => void;
  setLaunchTarget: (id: string) => void;
  /** Load everything and follow the backend's live updates. */
  loadAll: () => Promise<void>;
  loadWadspaces: () => Promise<void>;
  loadMachines: () => Promise<void>;
  loadDrafts: () => Promise<void>;
  loadFocus: () => Promise<FocusLock | null>;
  loadLastSession: () => Promise<void>;
  loadProjects: () => Promise<void>;
  patchWadspace: (id: string, patch: WadspacePatch) => Promise<Wadspace>;
  toast: (t: Omit<Toast, "id">) => number;
  updateToast: (id: number, t: Partial<Toast>) => void;
  dismiss: (id: number) => void;
  addDownload: (d: Download) => void;
  patchDownload: (wadspaceId: string, d: Partial<Download>) => void;
  removeDownload: (wadspaceId: string) => void;
  setWaitingFor: (wadspaceId: string | null) => void;
  addBuild: (b: BuildJob) => void;
  patchBuild: (id: string, b: Partial<BuildJob>) => void;
  removeBuild: (id: string) => void;
  setBuildLog: (id: string | null) => void;
  /** Progress and log lines from the backend. */
  applyBuild: (b: BuildProgress) => void;
  /** A launch's progress and log lines from the backend. */
  applyLaunch: (l: LaunchProgress) => void;
  removeLaunch: (id: string) => void;
  notify: (n: Omit<Notice, "id" | "at" | "read">) => void;
  readNotices: () => void;
  clearNotice: (id: number) => void;
}

let toastSeq = 0;
let noticeSeq = 0;

export interface Notice {
  id: number;
  title: string;
  body?: string;
  /** The wadspace it's about, so the notice can open it. */
  wadspaceId?: string;
  at: number;
  read: boolean;
}

export const useApp = create<AppState>((set, get) => ({
  user: null,
  users: [],
  wadspaces: [],
  machines: [],
  apps: [],
  drafts: [],
  focus: null,
  lastSession: null,
  clockSkew: 0,
  launchTarget: THIS_MACHINE,
  toasts: [],
  downloads: [],
  waitingFor: null,
  builds: [],
  buildLog: null,
  projects: [],
  launches: [],
  notices: [],

  setUser: (user) => set({ user }),
  setLaunchTarget: (launchTarget) => set({ launchTarget }),

  loadAll: async () => {
    const [users, apps] = await Promise.all([backend.users(), backend.apps()]);
    set({ users, apps, launchTarget: backend.defaultMachineId() ?? THIS_MACHINE });
    follow();
    backend.listBuilds?.().then((bs) => bs.forEach(get().applyBuild)).catch(() => {});
    backend.listLaunches?.().then((ls) => ls.forEach(get().applyLaunch)).catch(() => {});
    await Promise.all([get().loadWadspaces(), get().loadMachines(), get().loadDrafts(), get().loadFocus(), get().loadLastSession(), get().loadProjects()]);
  },
  loadWadspaces: async () => set({ wadspaces: await backend.listWadspaces() }),
  loadMachines: async () => {
    const machines = await backend.listMachines();
    const target = backend.defaultMachineId();
    const { wadspaces } = get();
    // Image downloads in progress on the launch target show in the sidebar.
    const downloads = (machines.find((m) => m.id === target)?.containers ?? [])
      .filter((c) => c.download)
      .map((c) => {
        const ws = wadspaces.find((w) => w.id === c.wadspaceId);
        return { wadspaceId: c.wadspaceId, name: ws?.name ?? c.wadspaceId, sizeMB: ws?.sizeMB ?? 0, progress: c.download!.progress ?? 0, label: c.download!.label };
      });
    set({ machines, downloads, launchTarget: target ?? get().launchTarget });
  },
  loadDrafts: async () => set({ drafts: await backend.listDrafts() }),
  loadFocus: async () => {
    const { focus, now } = await backend.getFocus();
    set({ focus, clockSkew: now - Date.now() });
    return focus;
  },
  loadLastSession: async () => set({ lastSession: await backend.lastSession() }),
  loadProjects: async () => {
    if (!backend.caps.projects) return;
    const projects = await backend.listProjects();
    set({ projects: [...projects].sort((a, b) => a.name.localeCompare(b.name)) });
  },
  patchWadspace: async (id, patch) => {
    const ws = await backend.patchWadspace(id, patch);
    set({ wadspaces: get().wadspaces.map((w) => (w.id === id ? ws : w)) });
    return ws;
  },

  toast: (t) => {
    const id = ++toastSeq;
    set({ toasts: [...get().toasts, { id, ...t }] });
    if (t.progress === undefined) setTimeout(() => get().dismiss(id), t.action ? 10000 : 4200);
    return id;
  },
  updateToast: (id, t) => set({ toasts: get().toasts.map((x) => (x.id === id ? { ...x, ...t } : x)) }),
  dismiss: (id) => set({ toasts: get().toasts.filter((x) => x.id !== id) }),

  addDownload: (d) => set({ downloads: [...get().downloads, d] }),
  patchDownload: (wadspaceId, d) => set({ downloads: get().downloads.map((x) => (x.wadspaceId === wadspaceId ? { ...x, ...d } : x)) }),
  removeDownload: (wadspaceId) => set({ downloads: get().downloads.filter((x) => x.wadspaceId !== wadspaceId) }),
  setWaitingFor: (waitingFor) => set({ waitingFor }),
  addBuild: (b) => set({ builds: [...get().builds, b] }),
  patchBuild: (id, b) => set({ builds: get().builds.map((x) => (x.id === id ? { ...x, ...b } : x)) }),
  removeBuild: (id) => set({ builds: get().builds.filter((x) => x.id !== id), buildLog: get().buildLog === id ? null : get().buildLog }),
  setBuildLog: (buildLog) => set({ buildLog }),
  applyBuild: (b) => {
    const prev = get().builds.find((x) => x.id === b.id);
    const lines = prev ? [...prev.lines.slice(0, b.from), ...b.lines] : b.lines;
    const job: BuildJob = {
      id: b.id,
      wadspaceId: b.wadspaceId,
      name: b.name,
      rebuild: prev?.rebuild ?? false,
      progress: b.progress,
      lines,
      status: b.status,
      error: b.error ?? undefined,
    };
    set({ builds: prev ? get().builds.map((x) => (x.id === b.id ? job : x)) : [...get().builds, job] });
    if (prev?.status === "building" && b.status !== "building") onBuildFinished(job, !!b.restartRequired);
  },
  applyLaunch: (l) => {
    const prev = get().launches.find((x) => x.id === l.id);
    // One that finished before the app saw it run (listed after a reload) is old news.
    if (!prev && !active(l)) return;
    const lines = prev ? [...prev.lines.slice(0, l.from), ...l.lines] : l.lines;
    const job: LaunchJob = {
      id: l.id,
      wadspaceId: l.wadspaceId,
      name: l.name,
      projects: l.projects,
      status: l.status,
      progress: l.progress,
      phase: l.phase,
      error: l.error ?? undefined,
      parts: l.parts,
      lines,
    };
    set({ launches: prev ? get().launches.map((x) => (x.id === l.id ? job : x)) : [...get().launches, job] });
    if (prev && active(prev) && !active(job)) onLaunchFinished(job);
  },
  removeLaunch: (id) => set({ launches: get().launches.filter((x) => x.id !== id) }),
  notify: (n) => set({ notices: [{ ...n, id: ++noticeSeq, at: Date.now(), read: false }, ...get().notices].slice(0, 20) }),
  readNotices: () => set({ notices: get().notices.map((n) => ({ ...n, read: true })) }),
  clearNotice: (id) => set({ notices: get().notices.filter((n) => n.id !== id) }),
}));

// Reload just what the backend says changed (wadd's events, Firestore listeners).
let following = false;
function follow() {
  if (following) return;
  following = true;
  const s = () => useApp.getState();
  const reload: Record<Topic, () => Promise<unknown>> = {
    user: async () => s().setUser(await backend.me().catch(() => null)),
    wadspaces: () => s().loadWadspaces(),
    drafts: () => s().loadDrafts(),
    machines: async () => {
      await s().loadMachines();
      // With an account, which wadspaces are "local" depends on the machines' state.
      if (hasAccount) await s().loadWadspaces();
    },
    focus: () => s().loadFocus(),
    session: () => s().loadLastSession(),
    projects: () => s().loadProjects(),
    // The pages that show the repo list listen for it themselves.
    github: async () => {},
  };
  backend.subscribe((t) => void reload[t]().catch(() => {}));
  backend.onBuild?.((b) => s().applyBuild(b));
  backend.onLaunch?.((l) => s().applyLaunch(l));
}

const active = (l: Pick<LaunchJob, "status">) => l.status === "queued" || l.status === "running";

/** A launch finished: refresh what it changed; a good one clears itself from the sidebar. */
function onLaunchFinished(job: LaunchJob) {
  const s = useApp.getState();
  s.loadWadspaces().catch(() => {});
  s.loadMachines().catch(() => {});
  if (job.status === "done") setTimeout(() => useApp.getState().removeLaunch(job.id), 6000);
  else if (job.status === "error") s.notify({ title: `${job.name} didn't start`, body: job.error ?? "See the launch log", wadspaceId: job.wadspaceId });
}

/** A build finished: refresh what it changed and say so from the profile icon. */
function onBuildFinished(job: BuildJob, restartRequired: boolean) {
  const s = useApp.getState();
  s.loadWadspaces().catch(() => {});
  s.loadMachines().catch(() => {});
  if (job.status === "done") {
    s.notify({
      title: `${job.name} is ready`,
      body: restartRequired ? "Built. It's running the old version until you restart it." : "Built on this machine",
      wadspaceId: job.wadspaceId,
    });
  } else {
    s.notify({ title: `${job.name} didn't build`, body: job.error ?? "See the build log", wadspaceId: job.wadspaceId });
  }
}

/** True when a focus session is active and this wadspace isn't part of it. */
export function isLocked(focus: FocusLock | null, wadspaceId?: string) {
  if (!focus) return false;
  return !wadspaceId || !focus.wadspaceIds.includes(wadspaceId);
}
