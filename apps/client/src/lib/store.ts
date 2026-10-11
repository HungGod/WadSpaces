// The WadSpaces Client's state: who's signed in, the Builder's documents
// (templates, customizations, wadspaces, WadBrowser setups) and the layer
// images on the launch machine, the machines, projects and saved sign-ins,
// builds and launches as they run, and the toasts and notices that report on
// them. The backend's events reload just what changed.
//
// The Builder's actions live here too: saving a layer, deleting softly (with
// Undo; "Recently deleted" restores or deletes for good), building a layer's
// image and launching the launcher's pick.
import { create } from "zustand";
import { backend, type Topic } from "@/data";
import type { BuildProgress, LaunchProgress } from "@/data/backend";
import type { Project } from "@core/projects";
import { imageKey, type BrowserSetup, type Customization, type LayerKey, type SignInRef, type Template, type WadspaceV2 } from "@core/layers";
import type { SecretKind } from "@core/layers";
import type { LayerLibrary } from "@/data/backend";
import { byLayer, imageState, type ImageRow, type ImageState, type RunItem } from "@/data/layers";
import { migrateToLayers } from "@/data/migrate";
import type { WaddSignIn } from "./wadd";
import type { BuildJob } from "./build";
import type { LaunchJob } from "./launch";
import { THIS_MACHINE, hasAccount } from "./machine";
import type { App, FocusLock, LastSession, Machine, PublicUser } from "./types";

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

/** The Builder's four kinds of document. */
export type LayerKind = "template" | "customization" | "wadspace" | "browser";

/** A document to save: its id (a new one gets one from its name), the rest the store fills in. */
export type New<T> = Omit<T, "id" | "owner" | "createdAt" | "updatedAt"> & { id?: string };

/** A saved sign-in as the Builder offers it: one on the machine, or one a
 *  wadspace or setup already names (online, made on the machine at its first launch). */
export type KnownSignIn = SignInRef;

interface AppState {
  user: PublicUser | null;
  users: PublicUser[];
  machines: Machine[];
  apps: App[];
  focus: FocusLock | null;
  lastSession: LastSession | null;
  /** serverNow - clientNow, so countdowns agree with the server clock. */
  clockSkew: number;
  launchTarget: string;
  toasts: Toast[];
  downloads: Download[];
  builds: BuildJob[];
  /** The build whose log is open. */
  buildLog: string | null;
  /** The launch whose progress and log are open. */
  launchLog: string | null;
  /** The user's projects (none deleted), by name. */
  projects: Project[];
  /** The launch machine's saved sign-ins, by name. */
  signIns: WaddSignIn[];
  /** Wadspaces getting their image and projects ready, then starting. */
  launches: LaunchJob[];
  /** Quiet notices that surface from the profile icon, e.g. "your wadspace is ready". */
  notices: Notice[];
  // The Builder's documents, deleted ones included (`deletedAt`): see `alive`.
  templates: Template[];
  customizations: Customization[];
  wadspaces: WadspaceV2[];
  browsers: BrowserSetup[];
  /** The layer images on the launch machine. */
  images: Partial<Record<LayerKey, ImageRow>>;
  /** The launch machine's screen, which desktops are laid out at. */
  machineScreen: { width: number; height: number };

  setUser: (u: PublicUser | null) => void;
  setLaunchTarget: (id: string) => void;
  /** Load everything and follow the backend's live updates. */
  loadAll: () => Promise<void>;
  loadMachines: () => Promise<void>;
  loadFocus: () => Promise<FocusLock | null>;
  loadLastSession: () => Promise<void>;
  loadProjects: () => Promise<void>;
  loadSignIns: () => Promise<void>;
  /** The Builder's documents (and, the first time, the starter templates). */
  loadLayers: () => Promise<void>;
  loadWadspaces: () => Promise<void>;
  loadImages: () => Promise<void>;
  /** Everything the Builder's documents are, as the backend takes them. */
  layerLib: () => LayerLibrary;
  /** How a layer's image stands on the launch machine. */
  imageState: (key: LayerKey) => ImageState;
  /** Saved sign-ins of every kind the Builder can offer. */
  knownSignIns: () => KnownSignIn[];

  saveTemplate: (t: New<Template>) => Promise<Template>;
  saveCustomization: (c: New<Customization>) => Promise<Customization>;
  /** Saves (and, on a machine, installs) the wadspace. */
  saveWadspace: (w: New<Omit<WadspaceV2, "version">>) => Promise<WadspaceV2>;
  saveBrowser: (b: New<BrowserSetup>) => Promise<BrowserSetup>;
  /** New sign-ins a draft names, made now (online: an id the machine makes it under). */
  createSignIns: (list: { name: string; kind: SecretKind }[]) => Promise<SignInRef[]>;
  /** Deleted softly, with Undo. Refused while live documents are built on it. */
  remove: (kind: LayerKind, id: string) => Promise<void>;
  restore: (kind: LayerKind, id: string) => Promise<void>;
  /** For good (its image too). Refused while anything is built on it, deleted or not. */
  purge: (kind: LayerKind, id: string) => Promise<void>;
  /** Builds a layer's image on the launch machine (its template's first when needed). */
  build: (key: LayerKey) => Promise<void>;
  /** Starts the launcher's pick together (a focus session with minutes). */
  launch: (items: RunItem[], focusMinutes: number | null) => Promise<boolean>;

  toast: (t: Omit<Toast, "id">) => number;
  updateToast: (id: number, t: Partial<Toast>) => void;
  dismiss: (id: number) => void;
  addBuild: (b: BuildJob) => void;
  patchBuild: (id: string, b: Partial<BuildJob>) => void;
  removeBuild: (id: string) => void;
  setBuildLog: (id: string | null) => void;
  setLaunchLog: (id: string | null) => void;
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

/** Not deleted. */
export const alive = <T extends { deletedAt?: string | null }>(list: T[]): T[] => list.filter((x) => !x.deletedAt);

const now = () => new Date().toISOString();
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "item";
/** An id from a name, free among these (deleted ones too: they can come back). */
export const freeId = (name: string, taken: { id: string }[]) => {
  const base = slug(name);
  let id = base;
  for (let n = 2; taken.some((x) => x.id === id); n++) id = `${base}-${n}`;
  return id;
};

/** What's built on a document: the names, for a refusal ("Writing setup, Cosmic"). */
function dependents(s: Pick<AppState, "customizations" | "wadspaces">, kind: LayerKind, id: string, includeDeleted: boolean) {
  const pick = <T extends { deletedAt?: string | null }>(l: T[]) => (includeDeleted ? l : alive(l));
  if (kind === "template")
    return [
      ...pick(s.customizations).filter((c) => c.templateId === id),
      ...pick(s.wadspaces).filter((w) => w.base.kind === "template" && w.base.id === id),
    ].map((x) => x.name + (x.deletedAt ? " (recently deleted)" : ""));
  if (kind === "customization")
    return pick(s.wadspaces)
      .filter((w) => w.base.kind === "customization" && w.base.id === id)
      .map((w) => w.name + (w.deletedAt ? " (recently deleted)" : ""));
  return [];
}

const LIST: Record<LayerKind, "templates" | "customizations" | "wadspaces" | "browsers"> = {
  template: "templates",
  customization: "customizations",
  wadspace: "wadspaces",
  browser: "browsers",
};

export const useApp = create<AppState>((set, get) => {
  /** Puts a saved document in its list. */
  const put = <K extends "templates" | "customizations" | "wadspaces" | "browsers">(list: K, d: AppState[K][number]) => {
    const cur = get()[list] as { id: string }[];
    set({ [list]: cur.some((x) => x.id === d.id) ? cur.map((x) => (x.id === d.id ? d : x)) : [...cur, d] } as Partial<AppState>);
  };
  const patchLayer = async (kind: LayerKind, id: string, deletedAt: string | null) => {
    const lib = get().layerLib();
    const saved =
      kind === "template"
        ? await backend.patchTemplate(id, { deletedAt })
        : kind === "customization"
          ? await backend.patchCustomization(id, { deletedAt })
          : kind === "wadspace"
            ? await backend.patchWadspace(id, { deletedAt }, lib)
            : await backend.patchBrowser(id, { deletedAt });
    put(LIST[kind], saved as never);
  };

  return {
    user: null,
    users: [],
    machines: [],
    apps: [],
    focus: null,
    lastSession: null,
    clockSkew: 0,
    launchTarget: THIS_MACHINE,
    toasts: [],
    downloads: [],
    builds: [],
    buildLog: null,
    launchLog: null,
    projects: [],
    signIns: [],
    launches: [],
    notices: [],
    templates: [],
    customizations: [],
    wadspaces: [],
    browsers: [],
    images: {},
    machineScreen: { width: 1920, height: 1080 },

    setUser: (user) => set({ user }),
    setLaunchTarget: (launchTarget) => set({ launchTarget }),

    loadAll: async () => {
      const [users, apps] = await Promise.all([backend.users(), backend.apps()]);
      set({ users, apps, launchTarget: backend.defaultMachineId() ?? THIS_MACHINE });
      follow();
      backend.listBuilds?.().then((bs) => bs.forEach(get().applyBuild)).catch(() => {});
      backend.listLaunches?.().then((ls) => ls.forEach(get().applyLaunch)).catch(() => {});
      await Promise.all([get().loadMachines(), get().loadFocus(), get().loadLastSession(), get().loadProjects(), get().loadSignIns(), get().loadLayers()]);
      // In the background: what's from before the layers moves onto them.
      migrate().catch(() => {});
    },
    loadLayers: async () => {
      // A library seen the first time gets the starter templates (once).
      await backend.createStarters().catch(() => {});
      const [templates, customizations, wadspaces, browsers, machineScreen] = await Promise.all([
        backend.listTemplates(),
        backend.listCustomizations(),
        backend.listWadspaces(),
        backend.listBrowsers(),
        backend.machineScreen().catch(() => get().machineScreen),
      ]);
      set({ templates, customizations, wadspaces, browsers, machineScreen });
      await get().loadImages();
    },
    loadWadspaces: async () => set({ wadspaces: await backend.listWadspaces() }),
    loadImages: async () => {
      set({ images: byLayer(await backend.listImages().catch(() => [])) });
      // A wadspace from before the layers runs its old image until its own is
      // built; from then on, the layer's (installed again on it).
      for (const w of get().wadspaces.filter((x) => x.legacyImage && !x.deletedAt)) {
        if (get().imageState(imageKey(w.base)) !== "built") continue;
        backend
          .patchWadspace(w.id, { legacyImage: null }, get().layerLib())
          .then((saved) => put("wadspaces", saved))
          .catch(() => {});
      }
    },
    layerLib: () => {
      const { templates, customizations, wadspaces, browsers } = get();
      return { templates, customizations, wadspaces, browsers };
    },
    imageState: (key) => {
      const building = new Set([...get().builds.filter((b) => b.status === "building" && b.layer).map((b) => b.layer!), ...(backend.buildingLayers?.() ?? [])]);
      return imageState(key, get().layerLib(), get().images, building);
    },
    knownSignIns: () => {
      const { signIns, wadspaces, browsers } = get();
      const out = new Map<string, SignInRef>(signIns.map((s) => [s.id, { id: s.id, name: s.name, kind: (s.app === "wadbrowser" ? "web" : s.app) as SecretKind }]));
      for (const d of [...alive(wadspaces), ...alive(browsers)]) for (const r of Object.values(d.secrets)) if (!out.has(r.id)) out.set(r.id, r);
      return [...out.values()];
    },
    loadMachines: async () => {
      const machines = await backend.listMachines();
      const target = backend.defaultMachineId();
      const { wadspaces } = get();
      // Image downloads in progress on the launch target show in the sidebar.
      const downloads = (machines.find((m) => m.id === target)?.containers ?? [])
        .filter((c) => c.download)
        .map((c) => ({ wadspaceId: c.wadspaceId, name: wadspaces.find((w) => w.id === c.wadspaceId)?.name ?? c.wadspaceId, sizeMB: 0, progress: c.download!.progress ?? 0, label: c.download!.label }));
      set({ machines, downloads, launchTarget: target ?? get().launchTarget });
    },
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
    loadSignIns: async () => {
      if (!backend.caps.signins && backend.target !== "online") return;
      set({ signIns: await backend.listSignIns().catch(() => []) });
    },

    // ------------------------------------------------------------ the Builder
    saveTemplate: async (t) => {
      const { templates } = get();
      const prev = t.id ? templates.find((x) => x.id === t.id) : undefined;
      const saved = await backend.saveTemplate({ ...prev, ...t, id: prev?.id ?? freeId(t.name, templates), owner: prev?.owner ?? backend.owner(), createdAt: prev?.createdAt ?? now(), updatedAt: now() } as Template);
      put("templates", saved);
      return saved;
    },
    saveCustomization: async (c) => {
      const { customizations } = get();
      const prev = c.id ? customizations.find((x) => x.id === c.id) : undefined;
      const saved = await backend.saveCustomization({ ...c, id: prev?.id ?? freeId(c.name, customizations), owner: prev?.owner ?? backend.owner(), createdAt: prev?.createdAt ?? now(), updatedAt: now() });
      put("customizations", saved);
      return saved;
    },
    saveWadspace: async (w) => {
      const { wadspaces } = get();
      const prev = w.id ? wadspaces.find((x) => x.id === w.id) : undefined;
      const next: WadspaceV2 = {
        ...w,
        version: 2,
        id: prev?.id ?? freeId(w.name, wadspaces),
        owner: prev?.owner ?? backend.owner(),
        // Still on its image from before the layers until they're built.
        ...(prev?.legacyImage && { legacyImage: prev.legacyImage }),
        createdAt: prev?.createdAt ?? now(),
        updatedAt: now(),
      };
      const lib = get().layerLib();
      const saved = await backend.saveWadspace(next, { ...lib, wadspaces: [...lib.wadspaces.filter((x) => x.id !== next.id), next] });
      put("wadspaces", saved);
      return saved;
    },
    saveBrowser: async (b) => {
      const { browsers } = get();
      const prev = b.id ? browsers.find((x) => x.id === b.id) : undefined;
      const saved = await backend.saveBrowser({ ...b, id: prev?.id ?? freeId(b.name, browsers), owner: prev?.owner ?? backend.owner(), createdAt: prev?.createdAt ?? now(), updatedAt: now() });
      put("browsers", saved);
      return saved;
    },
    createSignIns: async (list) => {
      const made: SignInRef[] = [];
      for (const s of list) {
        const r = await backend.createSignIn({ name: s.name, app: s.kind });
        made.push({ id: r.id, name: r.name, kind: s.kind });
      }
      if (made.length) get().loadSignIns().catch(() => {});
      return made;
    },
    remove: async (kind, id) => {
      const s = get();
      const doc = (s[LIST[kind]] as { id: string; name: string }[]).find((x) => x.id === id);
      if (!doc) return;
      const deps = dependents(s, kind, id, false);
      if (deps.length) throw new Error(`${deps.join(", ")} ${deps.length === 1 ? "is" : "are"} built on it: delete ${deps.length === 1 ? "that" : "those"} first.`);
      await patchLayer(kind, id, now());
      get().toast({ title: `Deleted ${doc.name}`, body: "It's in Recently deleted in the Builder.", action: { label: "Undo", onClick: () => void get().restore(kind, id) } });
    },
    restore: async (kind, id) => {
      const s = get();
      // A wadspace or customization comes back with what it's built on.
      if (kind === "wadspace") {
        const w = s.wadspaces.find((x) => x.id === id);
        if (w?.base.kind === "customization") {
          const c = s.customizations.find((x) => x.id === w.base.id);
          if (c?.deletedAt) await get().restore("customization", c.id);
        }
        const tid = w?.base.kind === "template" ? w.base.id : s.customizations.find((c) => c.id === w?.base.id)?.templateId;
        if (tid && s.templates.find((t) => t.id === tid)?.deletedAt) await patchLayer("template", tid, null);
      }
      if (kind === "customization") {
        const c = s.customizations.find((x) => x.id === id);
        if (c && s.templates.find((t) => t.id === c.templateId)?.deletedAt) await patchLayer("template", c.templateId, null);
      }
      await patchLayer(kind, id, null);
    },
    purge: async (kind, id) => {
      const deps = dependents(get(), kind, id, true);
      if (deps.length) throw new Error(`${deps.join(", ")} ${deps.length === 1 ? "is" : "are"} built on it: delete ${deps.length === 1 ? "that" : "those"} for good first.`);
      if (kind === "template") {
        await backend.deleteTemplate(id);
        await backend.deleteImage(`template:${id}`).catch(() => {});
      } else if (kind === "customization") {
        await backend.deleteCustomization(id);
        await backend.deleteImage(`custom:${id}`).catch(() => {});
      } else if (kind === "wadspace") await backend.deleteWadspace(id);
      else await backend.deleteBrowser(id);
      const list = LIST[kind];
      set({ [list]: (get()[list] as { id: string }[]).filter((x) => x.id !== id) } as Partial<AppState>);
      if (kind !== "browser" && kind !== "wadspace") get().loadImages().catch(() => {});
    },
    build: async (key) => {
      if (get().imageState(key) === "building") return;
      try {
        await backend.buildLayer(key, get().layerLib());
        // Online the heartbeat says when it's built; show it as building now.
        if (!backend.onBuild) await get().loadImages();
      } catch (e) {
        get().toast({ title: "Couldn't build", body: (e as Error).message, tone: "error" });
      }
    },
    launch: async (items, focusMinutes) => {
      if (!items.length) return false;
      try {
        await backend.launchItems(items, focusMinutes, get().layerLib());
      } catch (e) {
        get().toast({ title: "Couldn't launch", body: (e as Error).message, tone: "error" });
        return false;
      }
      get().loadLastSession().catch(() => {});
      if (focusMinutes) get().loadFocus().catch(() => {});
      return true;
    },

    toast: (t) => {
      const id = ++toastSeq;
      set({ toasts: [...get().toasts, { id, ...t }] });
      if (t.progress === undefined) setTimeout(() => get().dismiss(id), t.action ? 10000 : 4200);
      return id;
    },
    updateToast: (id, t) => set({ toasts: get().toasts.map((x) => (x.id === id ? { ...x, ...t } : x)) }),
    dismiss: (id) => set({ toasts: get().toasts.filter((x) => x.id !== id) }),

    addBuild: (b) => set({ builds: [...get().builds, b] }),
    patchBuild: (id, b) => set({ builds: get().builds.map((x) => (x.id === id ? { ...x, ...b } : x)) }),
    removeBuild: (id) => set({ builds: get().builds.filter((x) => x.id !== id), buildLog: get().buildLog === id ? null : get().buildLog }),
    setBuildLog: (buildLog) => set({ buildLog }),
    setLaunchLog: (launchLog) => set({ launchLog }),
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
        layer: b.layer ?? prev?.layer ?? null,
      };
      set({ builds: prev ? get().builds.map((x) => (x.id === b.id ? job : x)) : [...get().builds, job] });
      if (prev?.status === "building" && b.status !== "building") onBuildFinished(job);
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
    removeLaunch: (id) => set({ launches: get().launches.filter((x) => x.id !== id), launchLog: get().launchLog === id ? null : get().launchLog }),
    notify: (n) => set({ notices: [{ ...n, id: ++noticeSeq, at: Date.now(), read: false }, ...get().notices].slice(0, 20) }),
    readNotices: () => set({ notices: get().notices.map((n) => ({ ...n, read: true })) }),
    clearNotice: (id) => set({ notices: get().notices.filter((n) => n.id !== id) }),
  };
});

/** Moves the library from before the layers onto them (data/migrate.ts),
 *  once per load; a library already moved has nothing left to do. */
async function migrate() {
  const owner = backend.owner();
  if (!owner) return;
  const r = await migrateToLayers(backend, owner);
  const s = useApp.getState();
  if (r.migrated.length) await s.loadLayers();
  for (const n of r.notices) s.notify({ title: "Moved onto the Builder's layers", body: n });
}

// Reload just what the backend says changed (wadd's events, Firestore listeners).
let following = false;
function follow() {
  if (following) return;
  following = true;
  const s = () => useApp.getState();
  const reload: Record<Topic, () => Promise<unknown>> = {
    user: async () => s().setUser(await backend.me().catch(() => null)),
    wadspaces: () => s().loadWadspaces(),
    machines: async () => {
      await s().loadMachines();
      // Online, the default machine's heartbeat carries its images, sign-ins and screen.
      if (hasAccount) {
        await s().loadImages();
        await s().loadSignIns();
        useApp.setState({ machineScreen: await backend.machineScreen().catch(() => s().machineScreen) });
      }
    },
    focus: () => s().loadFocus(),
    session: () => s().loadLastSession(),
    projects: () => s().loadProjects(),
    signins: () => s().loadSignIns(),
    // The pages that show the repo list listen for it themselves.
    github: async () => {},
    templates: async () => useApp.setState({ templates: await backend.listTemplates() }),
    customizations: async () => useApp.setState({ customizations: await backend.listCustomizations() }),
    browsers: async () => useApp.setState({ browsers: await backend.listBrowsers() }),
    images: () => s().loadImages(),
  };
  backend.subscribe((t) => void reload[t]().catch(() => {}));
  backend.onBuild?.((b) => s().applyBuild(b));
  backend.onLaunch?.((l) => s().applyLaunch(l));
}

const active = (l: Pick<LaunchJob, "status">) => l.status === "queued" || l.status === "running";

/** A launch finished: refresh what it changed; a good one clears itself from the sidebar. */
function onLaunchFinished(job: LaunchJob) {
  const s = useApp.getState();
  s.loadMachines().catch(() => {});
  if (job.status === "done") setTimeout(() => useApp.getState().removeLaunch(job.id), 6000);
  else if (job.status === "error") s.notify({ title: `${job.name} didn't start`, body: job.error ?? "See the launch log", wadspaceId: job.wadspaceId });
}

/** A build finished: refresh the images and say so from the profile icon. */
function onBuildFinished(job: BuildJob) {
  const s = useApp.getState();
  s.loadImages().catch(() => {});
  s.loadMachines().catch(() => {});
  const what = job.layer ? undefined : job.wadspaceId;
  if (job.status === "done") s.notify({ title: `${job.name} is built`, body: "Its image is ready on the machine", wadspaceId: what });
  else s.notify({ title: `${job.name} didn't build`, body: job.error ?? "See the build log", wadspaceId: what });
}

/** True when a focus session is active and this wadspace isn't part of it. */
export function isLocked(focus: FocusLock | null, wadspaceId?: string) {
  if (!focus) return false;
  return !wadspaceId || !focus.wadspaceIds.includes(wadspaceId);
}
