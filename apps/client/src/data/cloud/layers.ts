// The Builder's layers online: the documents in Firestore, and the default
// machine's side through the cloud relay.
//
//   users/{uid}/templates/{id}        a template (the owner's; public ones come later)
//   users/{uid}/customizations/{id}   a customization
//   users/{uid}/browsers/{id}         a saved WadBrowser setup
//   wadspaces/{id}                    a wadspace (version 2; top level, with owner and
//                                     an empty sharedWith, as before)
//   profiles/{uid}.startersCreated    the starter templates were made once
//
// The machine's images, sign-ins (names only) and screen come in its
// heartbeat; a build, an install (with the wallpaper drawn here) and a
// launch are relay commands (wadd's cloud.rs runs them).
import { collection, deleteDoc, doc, getDoc, onSnapshot, setDoc, updateDoc, type DocumentData, type Unsubscribe } from "firebase/firestore";
import { STARTERS } from "@core/catalog/catalog";
import { imageKey, type BrowserSetup, type Customization, type LayerKey, type Template, type WadspaceV2 } from "@core/layers";
import type { LayerLibrary, LayerPatch, Topic } from "../backend";
import { byLayer, imageState, installBody, launchItem, layerRequest, timeZone, wallpaperUpload, type ImageRow, type RunItem } from "../layers";
import { db } from "./firebase";
import { commandResult, sendCommand, type RelayImage, type RelayScreen, type RelaySignIn } from "./relay";

// Firestore rejects undefined; drop it.
const clean = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

type Coll = "templates" | "customizations" | "browsers";

/** The documents, kept current by listeners while signed in. */
export class FirestoreLayerDocs {
  readonly templates = new Map<string, Template>();
  readonly customizations = new Map<string, Customization>();
  readonly browsers = new Map<string, BrowserSetup>();
  private unsubs: Unsubscribe[] = [];
  private uid: string | null = null;
  loaded: Promise<void> = Promise.resolve();

  constructor(private readonly emit: (t: Topic) => void) {}

  /** (Re)start the listeners for the signed-in user. */
  attach(uid: string | null) {
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    this.templates.clear();
    this.customizations.clear();
    this.browsers.clear();
    this.uid = uid;
    if (!uid) return;
    let pending = 3;
    let done!: () => void;
    this.loaded = new Promise((r) => (done = r));
    const watch = <T,>(name: Coll, into: Map<string, T>) => {
      let seen = false;
      const settle = () => {
        if (!seen) {
          seen = true;
          if (--pending === 0) done();
        }
      };
      this.unsubs.push(
        onSnapshot(
          collection(db, "users", uid, name),
          (snap) => {
            into.clear();
            for (const d of snap.docs) into.set(d.id, { ...d.data(), id: d.id } as T);
            settle();
            this.emit(name);
          },
          settle,
        ),
      );
    };
    watch("templates", this.templates);
    watch("customizations", this.customizations);
    watch("browsers", this.browsers);
  }

  private need(): string {
    if (!this.uid) throw new Error("Sign in first.");
    return this.uid;
  }

  async list<T>(name: Coll): Promise<T[]> {
    await this.loaded;
    return [...(this[name] as unknown as Map<string, T>).values()];
  }

  async put<T extends { id: string }>(name: Coll, d: T): Promise<T> {
    const { id, ...rest } = d;
    await setDoc(doc(db, "users", this.need(), name, id), clean(rest));
    return d;
  }

  async patch<T extends { id: string }>(name: Coll, id: string, patch: LayerPatch): Promise<T> {
    const cur = (this[name] as unknown as Map<string, T>).get(id);
    if (!cur) throw new Error("It's gone.");
    const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
    await updateDoc(doc(db, "users", this.need(), name, id), clean({ ...patch, updatedAt: next.updatedAt }) as DocumentData);
    return next as T;
  }

  async remove(name: Coll, id: string): Promise<void> {
    await deleteDoc(doc(db, "users", this.need(), name, id));
  }

  /** A v2 wadspace at the top level (its owner's), as the rules want it. */
  async putWadspace(w: WadspaceV2): Promise<WadspaceV2> {
    const { id, ...rest } = w;
    await setDoc(doc(db, "wadspaces", id), clean({ ...rest, owner: this.need(), sharedWith: [] }));
    return w;
  }

  async patchWadspace(id: string, cur: WadspaceV2, patch: LayerPatch): Promise<WadspaceV2> {
    const updatedAt = new Date().toISOString();
    await updateDoc(doc(db, "wadspaces", id), clean({ ...patch, updatedAt }) as DocumentData);
    const next: WadspaceV2 = { ...cur, ...patch, updatedAt } as WadspaceV2;
    if (next.deletedAt === null) delete next.deletedAt;
    return next;
  }

  async removeWadspace(id: string): Promise<void> {
    await deleteDoc(doc(db, "wadspaces", id));
  }

  /** The starters, made once (profiles/{uid}.startersCreated). */
  async createStarters(): Promise<Template[]> {
    const uid = this.need();
    const profile = await getDoc(doc(db, "profiles", uid));
    if (profile.data()?.startersCreated) return [];
    await this.loaded;
    const now = new Date().toISOString();
    const made: Template[] = [];
    for (const s of STARTERS) {
      if (this.templates.has(s.id)) continue;
      made.push(await this.put("templates", { ...s, owner: uid, starter: true as const, createdAt: now, updatedAt: now }));
    }
    await updateDoc(doc(db, "profiles", uid), { startersCreated: true });
    return made;
  }
}

/** A v2 wadspace document as the app has it. */
export function toWadspaceV2(id: string, d: DocumentData): WadspaceV2 {
  const { sharedWith: _s, sharedNames: _n, ownerName: _o, ...rest } = d;
  return { ...(rest as Omit<WadspaceV2, "id">), id };
}

/** The default machine as the Builder sees it, from its heartbeat; what it
 *  does, through relay commands. */
export class RelayMachine {
  /** Layers this app asked the machine to build, and when (Unix seconds),
   *  until its heartbeat shows an image built since. */
  private requested = new Map<string, number>();

  constructor(private readonly target: () => { uid: string; mid: string; heartbeat: DocumentData | undefined } | null) {}

  private need() {
    const t = this.target();
    if (!t) throw new Error("Link a WadSpaces machine to build and launch on it.");
    return t;
  }

  images(): ImageRow[] {
    return ((this.target()?.heartbeat?.images ?? []) as RelayImage[]).map((r) => ({ ...r, layer: r.layer as LayerKey }));
  }

  signIns(): RelaySignIn[] {
    return (this.target()?.heartbeat?.signins ?? []) as RelaySignIn[];
  }

  screen(): { width: number; height: number } {
    const s = this.target()?.heartbeat?.screen as RelayScreen | null | undefined;
    return s ? { width: s.width, height: s.height } : { width: 1920, height: 1080 };
  }

  /** Asks the machine to build a layer, with its documents. */
  async build(key: LayerKey, lib: LayerLibrary): Promise<string> {
    const { uid, mid } = this.need();
    const req = layerRequest(key, lib);
    const cmd = await sendCommand(uid, mid, "build", undefined, clean(req));
    const r = await commandResult(uid, mid, cmd);
    this.requested.set(key, Date.now() / 1000);
    return String(r.buildId ?? cmd);
  }

  /** A wadspace on the machine as it is now: the documents and the wallpaper drawn here. */
  async install(w: WadspaceV2, lib: LayerLibrary): Promise<void> {
    const { uid, mid } = this.need();
    const body = installBody(w, lib, timeZone());
    const cmd = await sendCommand(uid, mid, "install", w.id, clean({ ...body, wallpaper: await wallpaperUpload(w.wallpaper) }));
    await commandResult(uid, mid, cmd);
  }

  /** The launcher's pick on the machine: wadspaces installed (and built
   *  where needed, which the launch waits for there), then launched. */
  async launch(items: RunItem[], focusMinutes: number | null, lib: LayerLibrary): Promise<string[]> {
    const { uid, mid } = this.need();
    const images = byLayer(this.images());
    const ids = new Set(items.flatMap((i) => (i.kind === "wadspace" ? [i.wadspaceId] : [])));
    for (const id of ids) {
      const w = lib.wadspaces.find((x) => x.id === id);
      if (!w) continue;
      await this.install(w, lib);
      const key = imageKey(w.base);
      if (!w.legacyImage && ["never", "changed"].includes(imageState(key, lib, images, this.building()))) await this.build(key, lib);
    }
    const projectsOf = (id: string) => lib.wadspaces.find((w) => w.id === id)?.projects ?? [];
    const launchItems = await Promise.all(items.map((it, i) => launchItem(it, { background: i > 0, projectsOf })));
    const cmd = await sendCommand(uid, mid, "launch-run", undefined, clean({ items: launchItems, focusMinutes }));
    const r = await commandResult(uid, mid, cmd);
    return (r.workspaces as string[]) ?? [];
  }

  /** The layers building on the machine, as far as this app knows. */
  building(): Set<string> {
    return new Set(this.requested.keys());
  }

  /** A heartbeat came: layers built since they were asked for (or asked
   *  for more than two hours ago: a build that failed) aren't building. */
  sawHeartbeat() {
    const rows = byLayer(this.images());
    const now = Date.now() / 1000;
    for (const [key, at] of this.requested) {
      const row = rows[key as LayerKey];
      if ((row && row.builtAt >= at - 60) || now - at > 7200) this.requested.delete(key);
    }
  }
}
