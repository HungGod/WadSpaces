// The online backend: Firebase, and the user's machines through the relay.
//
// Stored model (firestore.rules has the access rules):
//   profiles/{uid}                  username, displayName, color, onboarded, lastSession
//   usernames/{name}                {uid}
//   users/{uid}/projects/{id}       name, mountName, source {kind: "git", url, ref?}, setup,
//                                   deleted (a tombstone), createdAt, updatedAt: what each project
//                                   is; the clones are on the machines, whose relay syncs this
//   users/{uid}/github/repos        {login, repos, updatedAt}: your GitHub repositories, shared
//                                   by your machines (the token stays on them)
//   users/{uid}/machines/{mid}      the relay heartbeat (wadd's cloud.rs) and its commands
//   the Builder's documents         see layers.ts (users/{uid}/templates, customizations,
//                                   browsers, and wadspaces/{id})
import {
  collection,
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  type DocumentData,
  type Query,
  type Timestamp,
  type Unsubscribe,
} from "firebase/firestore";
import { cleanDraft, toProjectDoc, validateProject, type GithubRepo, type Project, type ProjectDraft } from "@core/projects";
import { imageDataUrl } from "@/lib/images";
import type { Container, LastSession, Machine, PublicUser } from "@/lib/types";
import {
  Unsupported,
  type Backend,
  type Caps,
  type ContainerAction,
  type GithubRepoList,
  type Topic,
} from "../backend";
import { currentAuthUser, onAuthUser, signOut } from "./auth";
import { auth, db } from "./firebase";
import { ONLINE_WITHIN_MS, createEnrollCode, sendCommand, type CommandType, type RelayWorkspace } from "./relay";
import { FirestoreLayerDocs, RelayMachine, toWadspace } from "./layers";
import type { BrowserSetup, Extensions, LayerKey, Template, Wadspace } from "@core/layers";
import type { LayerLibrary, LayerPatch } from "../backend";
import type { RunItem } from "../layers";

const iso = (t: unknown) => (t && typeof (t as Timestamp).toDate === "function" ? (t as Timestamp).toDate().toISOString() : new Date().toISOString());
// Firestore rejects undefined; drop it.
const clean = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const PICK_KEY = "wadcreator.launchTarget";
// Firestore Timestamps as epoch ms; a write still on its way has none yet.
const ms = (t: unknown) => (t && typeof (t as Timestamp).toMillis === "function" ? (t as Timestamp).toMillis() : typeof t === "number" ? t : Date.now());
const TRUSTED_SOON = "Launching on a machine from the web arrives with trusted machines. For now, open it in WadSpaces on that machine.";
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
    copies: false,
    tailnet: false,
    signins: false,
  };

  private listeners = new Set<(t: Topic) => void>();
  private profiles = new Map<string, PublicUser & { uid: string }>();
  private owned = new Map<string, DocumentData>();
  private machines = new Map<string, DocumentData>();
  private projects = new Map<string, DocumentData>();
  /** users/{uid}/github/repos: undefined until the first snapshot, null when there's none. */
  private github: DocumentData | null | undefined;
  private githubError: string | null = null;
  private githubSeen: Promise<void> = Promise.resolve();
  private unsubs: Unsubscribe[] = [];
  private uid: string | null = null;
  private loaded: Promise<void> = Promise.resolve();
  /** The Builder's documents, and the default machine's side of them. */
  readonly docs = new FirestoreLayerDocs((t) => this.emit(t));
  readonly relay = new RelayMachine(() => {
    const mid = this.defaultMachineId();
    return this.uid && mid ? { uid: this.uid, mid, heartbeat: this.machines.get(mid) } : null;
  });

  /** `thisMachine`: in the machine app, this machine's id in the account.
   *  Its heartbeat is left out: the app shows the machine from wadd instead. */
  constructor(private opts: { thisMachine?: () => string | null } = {}) {
    onAuthUser((u) => this.attach(u?.uid ?? null));
  }

  /** The account's machines, without the one the app runs on. */
  private others(): [string, DocumentData][] {
    const skip = this.opts.thisMachine?.() ?? null;
    return [...this.machines].filter(([id]) => id !== skip);
  }

  /** The machine picked for "Open", if one was and it's still linked. */
  pickedMachine(): string | null {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(PICK_KEY);
    } catch {}
    return saved && this.others().some(([id]) => id === saved) ? saved : null;
  }

  /** Signed-in user's uid, or null. */
  uidNow(): string | null {
    return this.uid;
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
    this.machines.clear();
    this.projects.clear();
    this.github = undefined;
    this.githubError = null;
    this.uid = uid;
    this.docs.attach(uid);
    this.emit("user");
    if (!uid) return;

    // Loaded once each watched list has answered (or failed): counted from
    // the list itself, so one dropped or added can't leave `loaded` waiting.
    const watched: [Query<DocumentData>, Map<string, DocumentData>, Topic][] = [
      [query(collection(db, "wadspaces"), where("owner", "==", uid)), this.owned, "wadspaces"],
      [collection(db, "users", uid, "machines"), this.machines, "machines"],
      [collection(db, "users", uid, "projects"), this.projects, "projects"],
    ];
    let pending = watched.length;
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
            settle();
            this.emit(topic);
            // The heartbeats carry the Builder's images.
            if (topic === "machines") {
              this.relay.sawHeartbeat();
              this.emit("images");
            }
          },
          settle,
        ),
      );
    };
    for (const [q, into, topic] of watched) watch(q, into, topic);
    this.unsubs.push(onSnapshot(doc(db, "profiles", uid), () => this.emit("session")));
    // The repo list your machines share; not part of `loaded` (the Builder asks for it when it needs it).
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
    return this.tellMachines(uid, "projects-sync");
  }

  /** Send a command to your online machines (not the one the app runs on). How many were asked. */
  tellMachines(uid: string, type: CommandType) {
    let n = 0;
    for (const [mid, m] of this.others()) {
      if (!isUp(m)) continue;
      sendCommand(uid, mid, type).catch(() => {});
      n++;
    }
    return n;
  }

  // ---------------------------------------------------- the Builder's layers
  listTemplates() {
    return this.docs.list<Template>("templates");
  }
  saveTemplate(t: Template) {
    return this.docs.put("templates", t);
  }
  patchTemplate(id: string, patch: LayerPatch) {
    return this.docs.patch<Template>("templates", id, patch);
  }
  async deleteTemplate(id: string) {
    await this.docs.remove("templates", id);
  }
  listExtensions() {
    return this.docs.list<Extensions>("extensions");
  }
  saveExtensions(e: Extensions) {
    return this.docs.put("extensions", e);
  }
  patchExtensions(id: string, patch: LayerPatch) {
    return this.docs.patch<Extensions>("extensions", id, patch);
  }
  async deleteExtensions(id: string) {
    await this.docs.remove("extensions", id);
  }
  listOldCustomizations() {
    return this.docs.list<Extensions>("customizations");
  }
  deleteOldCustomization(id: string) {
    return this.docs.remove("customizations", id);
  }
  async listWadspaces() {
    await this.loaded;
    return [...this.owned].filter(([, d]) => d.version === 2 || d.version === 3).map(([id, d]) => toWadspace(id, d));
  }
  /** In the account; it reaches a machine when it's built or launched there. */
  saveWadspace(w: Wadspace) {
    return this.docs.putWadspace(w);
  }
  async patchWadspace(id: string, patch: LayerPatch) {
    const cur = this.owned.get(id);
    if (!cur) throw new Error("It's gone.");
    return this.docs.patchWadspace(id, toWadspace(id, cur) as Wadspace, patch);
  }
  async deleteWadspace(id: string) {
    await this.docs.removeWadspace(id);
  }
  /** On the default machine, through the relay. */
  installWadspace(w: Wadspace, lib: LayerLibrary) {
    return this.relay.install(w, lib);
  }
  listBrowsers() {
    return this.docs.list<BrowserSetup>("browsers");
  }
  saveBrowser(b: BrowserSetup) {
    return this.docs.put("browsers", b);
  }
  patchBrowser(id: string, patch: LayerPatch) {
    return this.docs.patch<BrowserSetup>("browsers", id, patch);
  }
  async deleteBrowser(id: string) {
    await this.docs.remove("browsers", id);
  }
  /** The default machine's, from its heartbeat. */
  async listImages() {
    await this.loaded;
    return this.relay.images();
  }
  buildLayer(key: LayerKey, lib: LayerLibrary) {
    return this.relay.build(key, lib);
  }
  /** Images stay on the machines: one there goes when it's deleted there. */
  async deleteImage() {}
  launchItems(items: RunItem[], focusMinutes: number | null, lib: LayerLibrary) {
    return this.relay.launch(items, focusMinutes, lib);
  }
  async machineScreen() {
    await this.loaded;
    return this.relay.screen();
  }
  owner() {
    return this.uid ?? "";
  }
  buildingLayers() {
    return [...this.relay.building()];
  }
  createStarters() {
    return this.docs.createStarters();
  }

  // --------------------------------------------------------- saved sign-ins
  /** They stay on the machines: the default one's names, from its heartbeat. */
  async listSignIns() {
    await this.loaded;
    return this.relay.signIns().map((s) => ({ ...s, paths: [], createdAt: 0, size: 0, changedAt: null, usedBy: [], inUse: [] }));
  }

  /** A sign-in to make on the machine: an id now, made there when it's first launched. */
  async createSignIn(input: { name: string; app: string }) {
    const slug = input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "signin";
    const tail = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
    return { id: `${slug}-${tail}`, name: input.name, app: input.app, paths: [], createdAt: Date.now(), size: 0, changedAt: null, usedBy: [], inUse: [] };
  }

  async updateSignIn(): Promise<never> {
    throw new Unsupported("Saved sign-ins (they're kept on a WadSpaces machine)");
  }

  async signOutSignIn(): Promise<never> {
    throw new Unsupported("Saved sign-ins (they're kept on a WadSpaces machine)");
  }

  async deleteSignIn(): Promise<never> {
    throw new Unsupported("Saved sign-ins (they're kept on a WadSpaces machine)");
  }

  async listSecrets() {
    return [];
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
    const tn = d.tailnet as { online?: boolean; ip?: string; dnsName?: string } | undefined;
    const containers: Container[] = ((d.workspaces ?? []) as RelayWorkspace[]).map((w) => ({
      id: w.id,
      wadspaceId: w.id,
      status: w.container === "running" ? "running" : "stopped",
      mode: w.port ? "stream" : "local",
      startedAt: iso(d.lastSeen),
      phase: w.phase as Container["phase"],
      error: w.error,
      onScreen: view === `workspace:${w.id}`,
      hotkey: w.hotkey,
      native: w.display === "host",
    }));
    return {
      id,
      name: d.hostname ?? id,
      label: d.name ?? d.hostname ?? id,
      os: d.daemonVersion ? `WadSpaces · wadd ${d.daemonVersion}` : "WadSpaces",
      status: isUp(d) ? "online" : "offline",
      // In the account: linked, by definition.
      linked: true,
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
    return this.others().map(([id, d]) => this.toMachine(id, d));
  }

  private async command(machineId: string, type: CommandType, wsId: string) {
    const uid = await this.requireUid();
    const m = this.machines.get(machineId);
    if (!m) throw new Error("That machine isn't linked to your account.");
    await sendCommand(uid, machineId, type, wsId);
    return m;
  }

  async container(machineId: string, containerId: string, action: ContainerAction) {
    if (action === "remove") throw new Unsupported("Doing that remotely");
    await this.command(machineId, action, containerId);
  }

  async createEnrollCode(machineName: string) {
    return createEnrollCode(await this.requireUid(), machineName.trim() || "WadSpaces machine");
  }

  // ---------------------------------------------------------------- focus
  async getFocus() {
    return { focus: null, now: Date.now() };
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

/** Signed in, but no username picked yet (the GitHub login wasn't free). */
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
