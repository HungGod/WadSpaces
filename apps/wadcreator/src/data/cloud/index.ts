// The online backend: Firebase, and the user's machines through the relay.
//
// Stored model (firestore.rules has the access rules):
//   profiles/{uid}                  username, displayName, color, onboarded, lastSession
//   usernames/{name}                {uid}
//   wadspaces/{id}                  owner (uid), ownerName, sharedWith [uid], sharedNames {uid: name},
//                                   name, description, visibility, layout, advanced, agent,
//                                   createdAt, updatedAt
//   users/{uid}/drafts/{id}
//   users/{uid}/projects/{id}       name, mountName, source {kind: "git", url, ref?}, setup,
//                                   deleted (a tombstone), createdAt, updatedAt: what each project
//                                   is; the clones are on the machines, whose relay syncs this
//   users/{uid}/github/repos        {login, repos, updatedAt}: your GitHub repositories, shared
//                                   by your machines (the token stays on them)
//   users/{uid}/machines/{mid}      the relay heartbeat (wadd/cloud.py) and its commands
//
// The UI keys people by username, so docs are translated on the way in and out.
import {
  collection,
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  type DocumentData,
  type Query,
  type Timestamp,
  type Unsubscribe,
} from "firebase/firestore";
import catalog from "@core/catalog/apps.json";
import { defaultAdvanced, dropFileIcons, newWadspaceId } from "@core/model";
import { cleanDraft, toProjectDoc, validateProject, type GithubRepo, type Project, type ProjectDraft } from "@core/projects";
import { presetProjects, presetWadspace } from "@core/presets";
import { imageDataUrl } from "@/lib/images";
import type { App, Container, Draft, LastSession, Machine, PublicUser, Wadspace } from "@/lib/types";
import {
  Unsupported,
  migrateDraft,
  type Backend,
  type Caps,
  type ContainerAction,
  type DraftInput,
  type GithubRepoList,
  type Topic,
  type WadspaceInput,
  type WadspacePatch,
} from "../backend";
import { hasRepos, knownProjectIds, migrateRepos, withProjects } from "../projects";
import { currentAuthUser, onAuthUser, signOut } from "./auth";
import { auth, db } from "./firebase";
import { ONLINE_WITHIN_MS, createEnrollCode, sendCommand, type CommandType, type RelayWorkspace } from "./relay";

const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "Etc/UTC";
const iso = (t: unknown) => (t && typeof (t as Timestamp).toDate === "function" ? (t as Timestamp).toDate().toISOString() : new Date().toISOString());
// Firestore rejects undefined; drop it.
const clean = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const PICK_KEY = "wadcreator.launchTarget";
// Firestore Timestamps as epoch ms; a write still on its way has none yet.
const ms = (t: unknown) => (t && typeof (t as Timestamp).toMillis === "function" ? (t as Timestamp).toMillis() : typeof t === "number" ? t : Date.now());
const TRUSTED_SOON = "Launching on a machine from the web arrives with trusted machines. For now, open it in Wad Creator on that machine.";
const NEW_REPO_ONLINE = "Make the repository on github.com/new, then pick it from your repos here once one of your machines has shared the list again.";
// Fields projects had before they were repositories, folders and drives; firestore.rules refuses them now.
const OLD_FIELDS = { holders: deleteField(), ignore: deleteField(), folderId: deleteField() };

export class CloudBackend implements Backend {
  readonly target = "online" as const;
  readonly caps: Caps = {
    sharing: false,
    localBuild: false,
    history: false,
    projects: true,
    tailnet: false,
  };

  private listeners = new Set<(t: Topic) => void>();
  private profiles = new Map<string, PublicUser & { uid: string }>();
  private owned = new Map<string, DocumentData>();
  private shared = new Map<string, DocumentData>();
  private machines = new Map<string, DocumentData>();
  private projects = new Map<string, DocumentData>();
  /** users/{uid}/github/repos: undefined until the first snapshot, null when there's none. */
  private github: DocumentData | null | undefined;
  private githubError: string | null = null;
  private githubSeen: Promise<void> = Promise.resolve();
  private unsubs: Unsubscribe[] = [];
  private uid: string | null = null;
  private loaded: Promise<void> = Promise.resolve();

  constructor() {
    onAuthUser((u) => this.attach(u?.uid ?? null));
  }

  // ------------------------------------------------------------- listening
  private emit(t: Topic) {
    this.listeners.forEach((fn) => fn(t));
  }

  subscribe(fn: (t: Topic) => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  /** (Re)start the Firestore listeners for the signed-in user. */
  private attach(uid: string | null) {
    if (uid === this.uid) return;
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    this.owned.clear();
    this.shared.clear();
    this.machines.clear();
    this.projects.clear();
    this.github = undefined;
    this.githubError = null;
    this.uid = uid;
    this.emit("user");
    if (!uid) return;

    let pending = 4;
    let done!: () => void;
    this.loaded = new Promise((r) => (done = r));
    const first = () => --pending === 0 && done();
    const watch = (q: Query<DocumentData>, into: Map<string, DocumentData>, topic: Topic) => {
      let seen = false;
      const settle = () => {
        if (!seen) {
          seen = true;
          first();
        }
      };
      this.unsubs.push(
        onSnapshot(
          q,
          async (snap) => {
            into.clear();
            for (const d of snap.docs) into.set(d.id, d.data());
            if (topic === "wadspaces") await this.loadProfiles([...into.values()].flatMap((d) => [d.owner, ...(d.sharedWith ?? [])]));
            settle();
            this.emit(topic);
          },
          settle,
        ),
      );
    };
    watch(query(collection(db, "wadspaces"), where("owner", "==", uid)), this.owned, "wadspaces");
    watch(query(collection(db, "wadspaces"), where("sharedWith", "array-contains", uid)), this.shared, "wadspaces");
    watch(collection(db, "users", uid, "machines"), this.machines, "machines");
    watch(collection(db, "users", uid, "projects"), this.projects, "projects");
    // Wadspaces and drafts saved before projects: their repos become projects.
    this.loaded.then(() => (this.uid === uid ? this.migrateRepos(uid) : undefined)).catch(() => {});
    this.unsubs.push(onSnapshot(collection(db, "users", uid, "drafts"), () => this.emit("drafts")));
    this.unsubs.push(onSnapshot(doc(db, "profiles", uid), () => this.emit("session")));
    // The repo list your machines share; not part of `loaded` (only the Projects page needs it).
    let seen!: () => void;
    this.githubSeen = new Promise((r) => (seen = r));
    this.unsubs.push(
      onSnapshot(
        doc(db, "users", uid, "github", "repos"),
        (d) => {
          this.github = d.exists() ? d.data() : null;
          this.githubError = null;
          seen();
          this.emit("github");
        },
        (e) => {
          this.github = null;
          this.githubError = e.message;
          seen();
          this.emit("github");
        },
      ),
    );
  }

  private async requireUid() {
    const u = await currentAuthUser();
    if (!u) throw new Error("Sign in first.");
    return u.uid;
  }

  // ---------------------------------------------------------------- people
  private async loadProfiles(uids: string[]) {
    const missing = [...new Set(uids)].filter((u) => u && !this.profiles.has(u));
    await Promise.all(
      missing.map(async (u) => {
        const d = await getDoc(doc(db, "profiles", u)).catch(() => null);
        if (d?.exists()) this.profiles.set(u, this.toUser(u, d.data()));
      }),
    );
  }

  private toUser(uid: string, d: DocumentData): PublicUser & { uid: string } {
    return {
      uid,
      username: d.username,
      displayName: d.displayName ?? d.username,
      color: d.color ?? "#c6ff1f",
      photoURL: d.photoURL ?? undefined,
      onboarded: !!d.onboarded,
      lastSession: d.lastSession ?? undefined,
    };
  }

  /** Null when signed out; throws NeedsUsername when signed in without a profile yet. */
  async me(): Promise<PublicUser | null> {
    const u = await currentAuthUser();
    if (!u) return null;
    const d = await getDoc(doc(db, "profiles", u.uid));
    if (!d.exists()) throw new NeedsUsername();
    const me = this.toUser(u.uid, d.data());
    this.profiles.set(u.uid, me);
    return me;
  }

  async signOut() {
    await signOut();
  }

  async setOnboarded() {
    await updateDoc(doc(db, "profiles", await this.requireUid()), { onboarded: true });
  }

  async users() {
    return [...this.profiles.values()];
  }

  private nameOf(uid: string) {
    return this.profiles.get(uid)?.username ?? uid;
  }

  private async uidOf(username: string) {
    for (const [uid, p] of this.profiles) if (p.username === username) return uid;
    const d = await getDoc(doc(db, "usernames", username.toLowerCase()));
    if (!d.exists()) throw new Error(`No user called ${username}.`);
    return d.data().uid as string;
  }

  async apps() {
    return catalog as App[];
  }

  // ------------------------------------------------------------ wadspaces
  private targetMachine() {
    const id = this.defaultMachineId();
    return id ? this.machines.get(id) : undefined;
  }

  private toWadspace(id: string, d: DocumentData): Wadspace {
    const onTarget = ((this.targetMachine()?.workspaces ?? []) as RelayWorkspace[]).find((w) => w.id === id);
    return {
      id,
      name: d.name,
      description: d.description ?? "",
      layout: dropFileIcons(d.layout),
      advanced: withProjects(d.advanced ?? defaultAdvanced(tz())),
      ...(d.agent && { agent: d.agent }),
      ...(d.dockerfile && { dockerfile: d.dockerfile }),
      owner: d.ownerName ?? this.nameOf(d.owner),
      visibility: d.visibility ?? "private",
      sharedWith: ((d.sharedWith ?? []) as string[]).map((u) => d.sharedNames?.[u] ?? this.nameOf(u)),
      installed: !!onTarget,
      local: !!onTarget && onTarget.phase !== "error",
      sizeMB: 0,
      updatedAt: iso(d.updatedAt),
      ...(d.templateId && { templateId: d.templateId }),
    };
  }

  /** Wadspaces built on a machine (offline) that aren't in the account: from the heartbeats. */
  private machineOnly(): Map<string, Wadspace> {
    const out = new Map<string, Wadspace>();
    const me = this.uid ? this.nameOf(this.uid) : "";
    for (const [mid, m] of this.machines) {
      for (const w of (m.workspaces ?? []) as RelayWorkspace[]) {
        if (this.owned.has(w.id) || this.shared.has(w.id) || out.has(w.id)) continue;
        const preset = presetWadspace(w.id);
        // The machine made the preset's projects and syncs them up; until then it has none.
        if (preset) preset.advanced.projects = knownProjectIds(this.liveProjects(), presetProjects(w.id));
        const label = (m.name ?? m.hostname ?? mid) as string;
        out.set(w.id, {
          ...(preset ?? {
            id: w.id,
            name: w.name,
            description: "",
            layout: { wallpaper: { type: "gradient", value: "radial-gradient(90% 70% at 80% 10%, #ff3d8155 0%, transparent 60%), #0a0614" }, icons: [], grid: true },
            advanced: defaultAdvanced(tz()),
          }),
          name: w.name,
          description: preset?.description || `On ${label}`,
          owner: me,
          visibility: "private",
          sharedWith: [],
          installed: mid === this.defaultMachineId(),
          local: mid === this.defaultMachineId() && w.phase !== "error",
          sizeMB: 0,
          updatedAt: iso(m.lastSeen),
          machineOnly: label,
        });
      }
    }
    return out;
  }

  async listWadspaces() {
    await this.loaded;
    const all = new Map([...this.shared, ...this.owned]);
    return [...[...all].map(([id, d]) => this.toWadspace(id, d)), ...this.machineOnly().values()];
  }

  async getWadspace(id: string) {
    await this.loaded;
    const cached = this.owned.get(id) ?? this.shared.get(id);
    if (cached) return this.toWadspace(id, cached);
    const onMachine = this.machineOnly().get(id);
    if (onMachine) return onMachine;
    const d = await getDoc(doc(db, "wadspaces", id)).catch(() => null);
    if (!d?.exists()) throw new Error("That wadspace doesn't exist or isn't shared with you.");
    await this.loadProfiles([d.data().owner]);
    return this.toWadspace(id, d.data());
  }

  async createWadspace(input: WadspaceInput) {
    const uid = await this.requireUid();
    const id = newWadspaceId(input.name);
    const body = clean({
      owner: uid,
      ownerName: this.nameOf(uid),
      name: input.name,
      description: input.description,
      visibility: input.visibility,
      sharedWith: [],
      sharedNames: {},
      layout: input.layout,
      advanced: input.advanced ?? defaultAdvanced(tz()),
      agent: input.agent,
      dockerfile: input.dockerfile,
      templateId: input.templateId,
    });
    await setDoc(doc(db, "wadspaces", id), { ...body, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    return this.toWadspace(id, { ...body, updatedAt: null });
  }

  async patchWadspace(id: string, patch: WadspacePatch) {
    const body: DocumentData = clean({ ...patch, sharedWith: undefined });
    if (patch.sharedWith) {
      const uids = await Promise.all(patch.sharedWith.map((n) => this.uidOf(n)));
      body.sharedWith = uids;
      body.sharedNames = Object.fromEntries(uids.map((u, i) => [u, patch.sharedWith![i]]));
    }
    await updateDoc(doc(db, "wadspaces", id), { ...body, updatedAt: serverTimestamp() });
    return this.getWadspace(id);
  }

  async deleteWadspace(id: string) {
    await deleteDoc(doc(db, "wadspaces", id));
  }

  // --------------------------------------------------------------- drafts
  async listDrafts() {
    const uid = await this.requireUid();
    const snap = await getDocs(collection(db, "users", uid, "drafts"));
    return snap.docs.map((d) => migrateDraft({ ...(d.data() as Draft), id: d.id, owner: this.nameOf(uid), updatedAt: iso(d.data().updatedAt) }));
  }

  async getDraft(id: string) {
    const uid = await this.requireUid();
    const d = await getDoc(doc(db, "users", uid, "drafts", id));
    if (!d.exists()) throw new Error("That draft is gone.");
    return migrateDraft({ ...(d.data() as Draft), id, owner: this.nameOf(uid), updatedAt: iso(d.data().updatedAt) });
  }

  async saveDraft(id: string | null, input: DraftInput) {
    const uid = await this.requireUid();
    const did = id ?? crypto.randomUUID();
    await setDoc(doc(db, "users", uid, "drafts", did), { ...clean(input), updatedAt: serverTimestamp() });
    return { ...input, id: did, owner: this.nameOf(uid), updatedAt: new Date().toISOString() };
  }

  async deleteDraft(id: string) {
    await deleteDoc(doc(db, "users", await this.requireUid(), "drafts", id));
  }

  // ------------------------------------------------------------- projects
  private toProject(id: string, d: DocumentData): Project {
    return toProjectDoc(id, d, ms);
  }

  private liveProjects(): Project[] {
    return [...this.projects]
      .map(([id, d]) => this.toProject(id, d))
      .filter((p) => !p.deleted)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async listProjects() {
    await this.loaded;
    return this.liveProjects();
  }

  /**
   * Timestamps are the server's (serverTimestamp), the same clock wadd's
   * last-writer-wins compares with its own. An edit also drops the fields
   * projects had before (OLD_FIELDS), which the rules now refuse.
   */
  async saveProject(p: ProjectDraft) {
    const uid = await this.requireUid();
    await this.loaded;
    const { id, ...body } = cleanDraft(p);
    if (id && this.toProject(id, this.projects.get(id) ?? {}).legacy) throw new Error("This project isn't a GitHub repository, so it can't be edited. Add the repository instead.");
    const errs = validateProject(body);
    if (errs.length) throw new Error(errs.join(" "));
    const clash = this.liveProjects().find((x) => x.id !== id && x.mountName === body.mountName);
    if (clash) throw new Error(`"${clash.name}" already uses the folder name ${body.mountName}.`);
    const ref = id ? doc(db, "users", uid, "projects", id) : doc(collection(db, "users", uid, "projects"));
    const fields = clean({ name: body.name, mountName: body.mountName, source: body.source, setup: body.setup ?? "" });
    // source is replaced whole, so a ref that's cleared goes too.
    if (id) await updateDoc(ref, { ...fields, ...OLD_FIELDS, deleted: false, updatedAt: serverTimestamp() });
    else await setDoc(ref, { ...fields, deleted: false, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    this.syncMachines(uid);
    return this.toProject(ref.id, { ...(this.projects.get(ref.id) ?? {}), ...fields, updatedAt: Date.now(), createdAt: Date.now() });
  }

  /** A tombstone, never a delete: machines that were away learn of it at their
   *  next sync. One from before GitHub (not a repository) can't be a valid
   *  tombstone any more, so it's deleted outright; machines can't push it back. */
  async deleteProject(id: string) {
    const uid = await this.requireUid();
    const ref = doc(db, "users", uid, "projects", id);
    if (this.toProject(id, this.projects.get(id) ?? {}).legacy) await deleteDoc(ref);
    else await updateDoc(ref, { ...OLD_FIELDS, deleted: true, updatedAt: serverTimestamp() });
    this.syncMachines(uid);
    return { purged: false };
  }

  async projectStatus() {
    return null;
  }

  /** Ask the online machines to sync projects (and share the repo list) now
   *  rather than at their next turn. How many were asked. */
  private syncMachines(uid: string) {
    let n = 0;
    for (const [mid, m] of this.machines) {
      if (!isUp(m)) continue;
      sendCommand(uid, mid, "projects-sync").catch(() => {});
      n++;
    }
    return n;
  }

  // --------------------------------------------------------------- GitHub
  /** Online there's no token here: a machine having shared the list means it has one. */
  async githubStatus() {
    await this.requireUid();
    await this.githubSeen;
    return { token: !!this.github, login: (this.github?.login as string | undefined) ?? null, ...(this.githubError && { error: this.githubError }) };
  }

  async listGithubRepos(): Promise<GithubRepoList> {
    await this.requireUid();
    await this.githubSeen;
    if (this.githubError) throw new Error(`Couldn't read the repos your machines shared: ${this.githubError}`);
    if (!this.github) return { login: null, repos: [], updatedAt: null, missing: "shared" };
    return { login: this.github.login ?? null, repos: (this.github.repos ?? []) as GithubRepo[], updatedAt: this.github.updatedAt ? ms(this.github.updatedAt) : null };
  }

  async createGithubRepo(): Promise<never> {
    throw new Unsupported("Making a repository from the web", NEW_REPO_ONLINE);
  }

  async refreshGithubRepos() {
    const uid = await this.requireUid();
    await this.loaded;
    return this.syncMachines(uid);
  }

  /** Owned wadspaces and drafts that still have advanced.repos: projects instead, saved back. */
  private async migrateRepos(uid: string) {
    for (const [id, d] of [...this.owned]) {
      if (!hasRepos(d.advanced)) continue;
      const advanced = await migrateRepos(this, d.advanced);
      await updateDoc(doc(db, "wadspaces", id), { advanced: clean(advanced), updatedAt: serverTimestamp() });
    }
    const drafts = await getDocs(collection(db, "users", uid, "drafts"));
    const batch = writeBatch(db);
    let n = 0;
    for (const d of drafts.docs) {
      if (!hasRepos(d.data().advanced)) continue;
      batch.update(d.ref, { advanced: clean(await migrateRepos(this, d.data().advanced)) });
      n++;
    }
    if (n) await batch.commit();
  }

  // ------------------------------------------------------------ launches
  async launch(): Promise<never> {
    throw new Unsupported("Launching", TRUSTED_SOON);
  }

  async cancelLaunch(): Promise<never> {
    throw new Unsupported("Launching", TRUSTED_SOON);
  }

  // ------------------------------------------------------------- machines
  defaultMachineId(): string | null {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(PICK_KEY);
    } catch {}
    if (saved && this.machines.has(saved)) return saved;
    const online = [...this.machines.entries()].find(([, d]) => isUp(d));
    return online?.[0] ?? this.machines.keys().next().value ?? null;
  }

  setDefaultMachine(id: string) {
    try {
      localStorage.setItem(PICK_KEY, id);
    } catch {}
    this.emit("machines");
    this.emit("wadspaces");
  }

  private toMachine(id: string, d: DocumentData): Machine {
    const view = d.view as string | null;
    const streams = (Array.isArray(d.streams) ? d.streams : []) as { wsId: string; url: string }[];
    const tn = d.tailnet as { online?: boolean; ip?: string; dnsName?: string } | undefined;
    const containers: Container[] = ((d.workspaces ?? []) as RelayWorkspace[]).map((w) => ({
      id: w.id,
      wadspaceId: w.id,
      status: w.container === "running" ? "running" : "stopped",
      mode: w.port ? "stream" : "local",
      startedAt: iso(d.lastSeen),
      phase: w.phase as Container["phase"],
      error: w.error,
      download: w.phase === "pulling" ? { progress: null, label: "downloading" } : null,
      onScreen: view === `workspace:${w.id}`,
      hotkey: w.hotkey,
      streamUrl: streams.find((x) => x.wsId === w.id)?.url ?? null,
    }));
    return {
      id,
      name: d.hostname ?? id,
      label: d.name ?? d.hostname ?? id,
      os: d.daemonVersion ? `WadSpaces · wadd ${d.daemonVersion}` : "WadSpaces",
      status: isUp(d) ? "online" : "offline",
      allowRemote: true,
      cpu: d.metrics?.cpu ?? null,
      ram: d.metrics?.mem ?? null,
      gpu: d.metrics?.gpu ?? "",
      ip: "",
      containers,
      version: d.daemonVersion,
      lastSeen: d.lastSeen ? iso(d.lastSeen) : null,
      tailnet: tn ? { online: !!tn.online && isUp(d), ip: tn.ip ?? null, dnsName: tn.dnsName ?? null } : null,
    };
  }

  async listMachines() {
    await this.loaded;
    return [...this.machines].map(([id, d]) => this.toMachine(id, d));
  }

  private async command(machineId: string, type: CommandType, wsId: string) {
    const uid = await this.requireUid();
    const m = this.machines.get(machineId);
    if (!m) throw new Error("That machine isn't linked to your account.");
    await sendCommand(uid, machineId, type, wsId);
    return m;
  }

  async open(machineId: string, wadspaceId: string) {
    const m = this.machines.get(machineId);
    const there = ((m?.workspaces ?? []) as RelayWorkspace[]).some((w) => w.id === wadspaceId);
    if (!there) throw new Error("It isn't on that machine yet. Build it there first, in Wad Creator on the machine.");
    await this.command(machineId, "switch", wadspaceId);
    await updateDoc(doc(db, "profiles", await this.requireUid()), {
      lastSession: { kind: "wadspace", wadspaceIds: [wadspaceId], machineId, at: new Date().toISOString() } satisfies LastSession,
    });
  }

  async container(machineId: string, containerId: string, action: ContainerAction) {
    if (action === "download" || action === "remove") throw new Unsupported("Doing that remotely");
    await this.command(machineId, action, containerId);
  }

  async createEnrollCode(machineName: string) {
    return createEnrollCode(await this.requireUid(), machineName.trim() || "WadSpaces machine");
  }

  // ---------------------------------------------------------------- focus
  async getFocus() {
    return { focus: null, now: Date.now() };
  }
  async startFocus(): Promise<void> {
    throw new Unsupported("Starting a focus session remotely");
  }
  async lastSession() {
    const uid = auth.currentUser?.uid;
    if (!uid) return null;
    const d = await getDoc(doc(db, "profiles", uid));
    return (d.data()?.lastSession as LastSession | undefined) ?? null;
  }

  async runs() {
    return [];
  }

  // --------------------------------------------------------------- images
  /** Kept inline in the wadspace doc, so it has to stay well under Firestore's 1 MiB. */
  async uploadImage(file: File) {
    return imageDataUrl(file, { max: 1280, quality: 0.75, type: "image/webp", maxBytes: 400 * 1024 });
  }
}

/** Signed in, but no username picked yet (first Google sign-in). */
export class NeedsUsername extends Error {
  constructor() {
    super("Pick a username to finish setting up your account.");
    // Checked by name in the router, which mustn't import this module (it's online-only).
    this.name = "NeedsUsername";
  }
}

function isUp(d: DocumentData) {
  const t = d.lastSeen as Timestamp | undefined;
  return !!t && typeof t.toDate === "function" && Date.now() - t.toDate().getTime() < ONLINE_WITHIN_MS;
}
