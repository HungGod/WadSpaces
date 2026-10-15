// The board's state: stacks, Recently deleted, undo, and which editor or
// dialog is open. The stacks are the documents' (sync.ts): each change is
// committed here, then written behind (the app's lists change at once), and
// a change made elsewhere (another device) is taken in when nothing of the
// board's is still being written. Images and builds are the launch
// machine's (the app store's); keys are its saved sign-ins.
import { useEffect } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { repoFullName } from "@core/projects";
import type { GithubRepo } from "@core/projects";
import type { LayerKey } from "@core/layers";
import { backend } from "@/data";
import { useApp } from "@/lib/store";
import { useTour } from "@/lib/tour";
import { app, problemsOf } from "./catalog";
import { plan, toBoard, withRefs, writes, type Docs } from "./sync";
import {
  BLANK_WALLPAPER,
  LAYER_INFO,
  appsOf,
  buildsOn,
  cloneModule,
  cloneSub,
  fitTemplates,
  isBlank,
  lookOf,
  moduleName,
  modulesOf,
  stackName,
  subOf,
  subParent,
  uid,
  type AnySub,
  type CustomizationModule,
  type Deleted,
  type Layer,
  type Module,
  type Stack,
  type TemplateModule,
  type SecretKind,
  type SecretRef,
} from "./model";
import type { Fix } from "./catalog";

/** Where dragged modules come from. */
export type ModuleSource = { kind: "stack"; stackId: string } | { kind: "deleted"; deletedId: string };
/** Where a dragged submodule comes from. */
export type SubSource = { kind: "module"; stackId: string; layer: "extensions" | "customization" } | { kind: "deleted"; deletedId: string };

export interface Editing {
  stackId: string;
  /** The module being edited (a stack can hold several templates). */
  moduleId: string;
  layer: Layer;
  /** A module that doesn't exist yet: Save adds it (Cancel, or saving it empty, drops it). */
  fresh?: Module;
  /** The submodule to open on, e.g. "secrets". */
  focus?: string;
  /** Where the module was, to grow out of and shrink back into. */
  from: { x: number; y: number; w: number; h: number };
}

export interface Toast {
  id: string;
  text: string;
  undo?: boolean;
}

interface Snapshot {
  stacks: Stack[];
  deleted: Deleted[];
}

/** Modules about to be deleted, a whole stack among them, waiting on "Are you sure?". */
export interface Confirming {
  ids: string[];
}

interface State extends Snapshot {
  past: Snapshot[];
  /** Whether the stacks have been read from the documents yet. */
  loaded: boolean;
  /** Your GitHub repositories, to clone into a customization (loaded when asked for). */
  repos: GithubRepo[] | null;
  /** Reads the board from the documents (or takes in what changed there). */
  load(docs: Docs, force?: boolean): void;
  /** The board while its documents aren't all saved (kept on this machine, across a restart); null when they are. */
  unsaved: Stack[] | null;
  /** Why the last save failed, until one goes through. */
  saveError: string | null;
  /** Writes what isn't saved yet again. */
  retrySave(): void;
  loadRepos(): Promise<void>;
  editing: Editing | null;
  /** The stack being previewed. */
  preview: string | null;
  confirming: Confirming | null;
  /** Modules picked out with Ctrl+click, for the Build and Delete buckets (or the Delete key). */
  selected: string[];
  toasts: Toast[];

  /** Whether `modules` can go on `stackId`, and what they'd replace there ("its Extensions"). */
  canPlace(modules: Module[], stackId: string, from: ModuleSource): { ok: boolean; why?: string; replaces?: string };
  /** Copies them onto the stack, or moves them there with `move`. */
  placeModules(modules: Module[], from: ModuleSource, stackId: string, move?: boolean): void;
  /** Starts a new stack at `at` with them (copied, or moved with `move`), on copies of `base` if given. */
  newStack(modules: Module[], from: ModuleSource, at: number, move?: boolean, base?: TemplateModule[]): void;
  /** Whether these modules, on copies of `base`, make a stack. */
  canStart(modules: Module[], base?: TemplateModule[]): { ok: boolean; why?: string };
  /** Deletes one module; a grab of several asks first, then deletes the whole stack. */
  deleteModules(modules: Module[], from: ModuleSource): void;
  /** Recently deleted entries gone for good (by id), with the documents behind them that nothing else uses. */
  deleteForever(ids: string[]): Promise<void>;
  /** Deletes these modules (by id): the confirmed path. */
  deleteIds(ids: string[]): void;
  toggleSelect(id: string): void;
  clearSelection(): void;
  /** Deletes what's selected; asks first if that's a whole stack. */
  deleteSelected(): void;
  /** Builds the images a stack doesn't have yet (installing it first), on the launch machine. */
  buildStack(stackId: string): void;
  /** Builds the stacks the selected modules are in. */
  buildSelected(): void;
  /** Builds every stack that needs it (and can be: a template to build on, nothing to fix). */
  buildAll(): void;
  /** Makes a new key (a saved sign-in) of a kind, named after `base` (made unique). */
  createKey(kind: SecretKind, base: string): Promise<SecretRef>;
  /** Renames a key everywhere it's kept; returns why it can't, or null. */
  renameKey(id: string, name: string): string | null;
  /** Applies a fix to a stack's configuration. */
  fix(stackId: string, f: Fix): void;
  /** Makes a GitHub repository (on a machine); its owner/name, or why it can't. */
  createProject(name: string): Promise<{ repo: string } | string>;
  /** Adds a stack at the right-hand end with a blank template (a free name); returns its id. */
  createStack(): string;
  /** The stack just made with Create, to scroll to and highlight. */
  created: string | null;
  confirm(c: Confirming | null): void;

  canPlaceSub(sub: AnySub, stackId: string, layer: Layer, from: SubSource): { ok: boolean; why?: string };
  placeSub(sub: AnySub, from: SubSource, to: { stackId: string; layer: "extensions" | "customization" }, move?: boolean): void;
  deleteSub(sub: AnySub, from: SubSource): void;

  /** Saves an editor's module: into its stack, or (fresh) as a new module or a new stack. */
  saveModule(e: Editing, m: Module): void;
  /** Renames a module where it sits (a customization's name is its look's). */
  /** Returns why it can't, or null when renamed. */
  rename(stackId: string, moduleId: string, name: string): string | null;
  openEditor(e: Editing): void;
  closeEditor(): void;
  openPreview(stackId: string | null): void;

  toast(text: string, undo?: boolean): void;
  dismiss(id: string): void;
  undo(): void;
}

const snap = (s: Snapshot): Snapshot => ({ stacks: s.stacks, deleted: s.deleted });

/** The documents as the app has them now. */
const docsNow = (): Docs => {
  const { templates, extensions, wadspaces } = useApp.getState();
  return { templates, extensions, wadspaces };
};

/** Writes in flight: while any are, a change in the documents is the board's own. */
let pending = 0;
/** After a failed write, until the app's lists are read back: they're the board's, not what's saved. */
let stale = false;

/** Tests: the app started again (no writes out). */
export function forgetWritesForTests() {
  pending = 0;
  stale = false;
}

/** Writes the board's documents: the app's lists at once, the backend behind.
 *  Until every write is in, the board is kept on this machine too (`unsaved`):
 *  a write that fails, no network, or a restart between loses nothing; the
 *  board is written again (on the next change, Retry, or the next start). */
async function save(stacks: Stack[]): Promise<Stack[]> {
  if (stale) {
    useBoard.setState({ unsaved: stacks });
    return stacks;
  }
  const p = plan(stacks, docsNow(), backend.owner(), new Date().toISOString());
  if (!writes(p)) {
    if (!pending) useBoard.setState({ unsaved: null, saveError: null });
    return stacks;
  }
  const { templates, extensions, wadspaces } = p.docs;
  useApp.setState({ templates, extensions, wadspaces });
  const kept = withRefs(stacks, p.refs);
  useBoard.setState({ unsaved: kept });
  pending++;
  void (async () => {
    try {
      for (const t of p.templates) await backend.saveTemplate(t);
      for (const e of p.extensions) await backend.saveExtensions(e);
      for (const w of p.wadspaces) await backend.saveWadspace(w);
      for (const id of p.deleted) await backend.patchWadspace(id, { deletedAt: new Date().toISOString() });
    } catch (e) {
      const why = (e as Error).message;
      if (!useBoard.getState().saveError)
        useApp.getState().toast({ title: "Couldn't save the board", body: `${why} Your changes are kept on this machine and saved when they can be.`, tone: "error" });
      useBoard.setState({ saveError: why, unsaved: useBoard.getState().stacks });
      // The app's lists back to what's saved; the board keeps its work.
      stale = true;
      pending = 0;
      await useApp.getState().loadLayers().catch(() => {});
      stale = false;
      return;
    }
    pending = Math.max(0, pending - 1);
    if (!pending && !stale) useBoard.setState({ unsaved: null, saveError: null });
  })();
  return kept;
}

/** Every key there is of a kind: the machine's saved sign-ins and the ones the board's stacks keep. */
export function keysOfKind(keys: SecretRef[], stacks: Stack[], kind: SecretKind): SecretRef[] {
  const out = new Map<string, SecretRef>();
  for (const k of keys) if (k.kind === kind) out.set(k.id, k);
  for (const st of stacks) {
    const sub = subOf(st.customization, "secrets");
    for (const k of [...Object.values(sub?.bySlot ?? {}), ...(sub?.groups ?? []).map((g) => g.key)]) if (k && k.kind === kind) out.set(k.id, k);
  }
  return [...out.values()];
}

/** The stack id a module for a new wadspace (on an empty board) edits under. */
export const NEW = "new";

/** The layer image a module is ("template:<id>" / "custom:<id>"), or null: a customization has none, nor a module not saved yet. */
export function imageOf(m: Module): LayerKey | null {
  if (m.layer === "customization" || !m.ref) return null;
  return m.layer === "template" ? `template:${m.ref}` : `custom:${m.ref}`;
}

export type BuildState = "built" | "update" | "unbuilt";

/**
 * Where a module stands on the launch machine. A customization always counts
 * as built: it has no image (wadd hands it over when the wadspace starts).
 * Blank ones count as built too: an empty Extensions has nothing to build, a
 * template with no apps is the base image.
 */
export function buildStateOf(m: Module): BuildState {
  if (m.layer === "customization") return "built";
  if (m.layer === "extensions" ? !m.subs.length : !m.apps.length) return "built";
  const img = imageOf(m);
  const state = img ? useApp.getState().imageState(img) : "never";
  return state === "built" ? "built" : state === "update" ? "update" : "unbuilt";
}

/** The modules in a stack still to build. */
export const unbuiltOf = (stack: Stack) => modulesOf(stack).filter((m) => buildStateOf(m) === "unbuilt");

/** The modules in a stack built on an older base (or template): building again updates them. */
export const updatesOf = (stack: Stack) => modulesOf(stack).filter((m) => buildStateOf(m) === "update");

/** What building a stack does: its images not built, and those with an update. */
export const toBuildOf = (stack: Stack) => modulesOf(stack).filter((m) => buildStateOf(m) !== "built");

/** Whether a stack's image is building. */
export const isBuilding = (stack: Stack) => modulesOf(stack).some((m) => {
  const img = imageOf(m);
  return !!img && useApp.getState().imageState(img) === "building";
});

/** Re-renders with the machine's images and builds. */
export const useImages = () => {
  useApp((s) => s.images);
  useApp((s) => s.builds);
};

const appName = (id: string) => app(id)?.name ?? id;

/** The stack without these modules (by id); a stack left empty goes. */
function without(stacks: Stack[], stackId: string, ids: string[]): Stack[] {
  return stacks
    .map((s) => {
      if (s.id !== stackId) return s;
      const next: Stack = { ...s, templates: s.templates.filter((t) => !ids.includes(t.id)) };
      if (next.extensions && ids.includes(next.extensions.id)) delete next.extensions;
      if (next.customization && ids.includes(next.customization.id)) delete next.customization;
      return next;
    })
    .filter((s) => modulesOf(s).length > 0);
}

/** `stack` with `modules` added: templates where they build on what's below, the rest in their layer. */
/**
 * `stack` with `modules` added. Nothing's refused: a layer it already has is
 * replaced; templates go where they build on what's below, and a template that
 * doesn't fit replaces the stack's templates. Whatever doesn't add up after
 * (setups or keys for an app it doesn't have) shows as a problem to fix.
 */
export function place(stack: Stack, modules: Module[]): { ok: true; stack: Stack; replaced: Module[] } | { ok: false; why: string } {
  const adding = modules.filter((m): m is TemplateModule => m.layer === "template");
  for (let i = 1; i < adding.length; i++) {
    const v = buildsOn(adding[i], adding[i - 1], appName);
    if (!v.ok) return { ok: false, why: v.why! };
  }
  const next: Stack = { ...stack, templates: [...stack.templates] };
  const replaced: Module[] = [];
  for (const m of modules) {
    if (m.layer === "template") continue;
    const there = stack[m.layer];
    if (there) replaced.push(there);
    if (m.layer === "extensions") next.extensions = m;
    else next.customization = m;
  }
  if (adding.length) {
    const fit = fitTemplates(next.templates, adding, appName);
    if (fit.ok) next.templates.splice(fit.at, 0, ...adding);
    else {
      replaced.push(...next.templates);
      next.templates = adding;
    }
  }
  return { ok: true, stack: next, replaced };
}

/** "its Extensions", "its templates"…: what a drop would replace, in words. */
const replacing = (ms: Module[]) =>
  [...new Set(ms.map((m) => (m.layer === "template" ? "templates" : m.layer === "extensions" ? "Extensions" : "Customization")))].map((w) => `its ${w}`).join(" and ");

/** Copies of `base` with these modules on top; a dragged template the same as one in `base` folds into it. */
function onBase(modules: Module[], base: TemplateModule[]): Module[] {
  const sig = (t: TemplateModule) => [...t.apps].sort().join(",");
  const have = new Set(base.map(sig));
  return [...base.map((t) => cloneModule(t, false)), ...modules.filter((m) => m.layer !== "template" || !have.has(sig(m)))];
}

/** A new stack holding these modules. */
function fresh(modules: Module[]): Stack {
  const r = place({ id: uid("stack"), templates: [] }, modules);
  // (an empty stack replaces nothing)
  return r.ok ? r.stack : { id: uid("stack"), templates: [] };
}

/** A copied customization's name: the original's with " - n", n counting the copies. */
export function copyName(name: string, taken: string[]): string {
  const base = name.replace(/ - \d+$/, "");
  if (!base.trim()) return name;
  const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} - (\\d+)$`);
  const n = Math.max(0, ...taken.map((t) => Number(t.match(re)?.[1] ?? 0)));
  return `${base} - ${n + 1}`;
}

/** Templates with the same apps are one template (the same image), shared by the stacks that have it. */
export const sameApps = (a: TemplateModule, b: TemplateModule) => a.apps.length === b.apps.length && a.apps.every((x) => b.apps.includes(x));

/** Renames a shared template everywhere it's used. Returns the stacks and how many of them it touched. */
function renameTemplate(stacks: Stack[], t: TemplateModule, name: string): { stacks: Stack[]; count: number } {
  let count = 0;
  const next = stacks.map((st) => {
    if (!st.templates.some((x) => sameApps(x, t))) return st;
    count++;
    return { ...st, templates: st.templates.map((x) => (sameApps(x, t) ? { ...x, name } : x)) };
  });
  return { stacks: next, count };
}

/**
 * What makes two Extensions modules the same layer (the same image): the
 * template they're built on (its apps) and their app setups. Stacks that
 * differ only in their customization share it, and its name.
 */
export function extSig(s: Stack): string | null {
  const e = s.extensions;
  if (!e) return null;
  const sorted = (xs: string[]) => [...xs].sort().join(",");
  const subs = [...e.subs]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((x) => (x.key === "vscode" ? `vscode:${sorted(x.extensions)}` : x.key === "tools" ? `tools:${sorted(x.tools)}` : `wadbrowser:${x.mode}:${sorted(x.webapps.map((w) => `${w.id}=${w.url}`))}`));
  return `${sorted(appsOf(s))}#${subs.join("|")}`;
}

/**
 * Why `name` can't be `m`'s (in stack `stackId`), or null when it can. Names
 * are unique per kind: a customization's among customizations; an
 * Extensions' among Extensions, but for the ones it's shared with (same
 * template, same setups); a template's among templates, but for the ones
 * with the same apps (the same, shared, template).
 */
export function nameClash(stacks: Stack[], stackId: string, m: Module, name: string): string | null {
  const want = name.trim().toLowerCase();
  if (!want) return null;
  const same = (n: string | undefined) => (n ?? "").trim().toLowerCase() === want;
  if (m.layer === "customization") {
    const other = stacks.find((st) => st.id !== stackId && st.customization && st.customization.id !== m.id && same(lookOf(st)?.name));
    return other ? `${stackName(other)} already uses that name` : null;
  }
  if (m.layer === "extensions") {
    const home = stacks.find((st) => st.id === stackId);
    const sig = home ? extSig({ ...home, extensions: m }) : null;
    const other = stacks.find((st) => st.extensions && st.extensions.id !== m.id && same(st.extensions.name) && extSig(st) !== sig);
    return other ? `${stackName(other)}'s Extensions already use that name` : null;
  }
  const other = stacks.flatMap((st) => st.templates).find((t) => t.id !== m.id && same(t.name) && !sameApps(t, m));
  return other ? `Another template (with different apps) is already called ${other.name}` : null;
}

/** A copied Extensions module's name: shared with a stack it's the same layer as, else "<original> - n". */
function nameCopiedExtensions(stacks: Stack[], stackId: string, extId: string | undefined): Stack[] {
  const st = stacks.find((x) => x.id === stackId);
  if (!extId || !st?.extensions || st.extensions.id !== extId) return stacks;
  const sig = extSig(st);
  const others = stacks.filter((x) => x.id !== stackId);
  const twin = others.find((x) => extSig(x) === sig);
  const name = twin ? twin.extensions!.name : copyName(st.extensions.name, others.map((x) => x.extensions?.name ?? ""));
  return stacks.map((x) => (x.id === stackId ? { ...x, extensions: { ...x.extensions!, name } } : x));
}

/** A copied customization module, named "<original> - n" (templates keep their names: they're shared). */
function renamed(m: Module, stacks: Stack[]): Module {
  // Extensions are named once they've landed: see nameCopiedExtensions.
  if (m.layer !== "customization") return m;
  const c = m as CustomizationModule;
  const taken = stacks.map((s) => lookOf(s)?.name ?? "");
  return { ...c, subs: c.subs.map((x) => (x.key === "look" && x.name.trim() ? { ...x, name: copyName(x.name, taken) } : x)) };
}

/** The modules as they land: moved as they are, or copied (new ids; copied customizations and extensions renamed). */
function landing(modules: Module[], from: ModuleSource, move: boolean | undefined, stacks: Stack[]): Module[] {
  if (move || from.kind === "deleted") return modules;
  return modules.map((m) => renamed(cloneModule(m, false), stacks));
}

/**
 * The templates on the board a new template has all the apps of, as the
 * longest chain each building on the one before (Dev → Game Dev), so the new
 * one can stack on top of them.
 */
export function chainUnder(t: TemplateModule, stacks: Stack[]): TemplateModule[] {
  const sig = (apps: string[]) => [...apps].sort().join(",");
  const within = (a: TemplateModule, b: { apps: string[] }) => a.apps.length < b.apps.length && a.apps.every((x) => b.apps.includes(x));
  const found = new Map<string, TemplateModule>();
  for (const s of stacks) for (const x of s.templates) if (x.apps.length && within(x, t) && !found.has(sig(x.apps))) found.set(sig(x.apps), x);
  const c = [...found.values()].sort((a, b) => a.apps.length - b.apps.length);
  const best = c.map((x) => [x]);
  for (let i = 0; i < c.length; i++) for (let j = 0; j < i; j++) if (within(c[j], c[i]) && best[j].length + 1 > best[i].length) best[i] = [...best[j], c[i]];
  return best.reduce<TemplateModule[]>((a, b) => (b.length > a.length || (b.length === a.length && b.at(-1)!.apps.length > (a.at(-1)?.apps.length ?? 0)) ? b : a), []);
}

function editSubs(stacks: Stack[], stackId: string, layer: "extensions" | "customization", fn: (subs: AnySub[]) => AnySub[]): Stack[] {
  return stacks.map((s) => {
    if (s.id !== stackId) return s;
    const m = s[layer];
    if (!m) return s;
    return { ...s, [layer]: { ...m, subs: fn(m.subs as AnySub[]) } };
  });
}

const sourceName = (stacks: Stack[], from: ModuleSource | SubSource) =>
  from.kind === "stack" || from.kind === "module" ? stackName(stacks.find((s) => s.id === from.stackId) ?? { id: "", templates: [] }) : "Recently deleted";

const title = (m: Module) => `${moduleName(m)} (${LAYER_INFO[m.layer].label.toLowerCase()})`;

export const useBoard = create<State>()(
  persist(
    (set, get) => {
      /** Every change goes through here, so it can be undone; its documents are written behind. */
      const commit = (next: Partial<Snapshot>) => {
        set((s) => ({ past: [...s.past.slice(-40), snap(s)], ...next }));
        if (next.stacks) void save(next.stacks).then((stacks) => stacks !== get().stacks && set({ stacks }));
      };
      const takeFromDeleted = (deleted: Deleted[], from: ModuleSource | SubSource) =>
        from.kind === "deleted" ? deleted.filter((d) => d.id !== from.deletedId) : deleted;

      return {
        stacks: [],
        deleted: [],
        loaded: false,
        repos: null,
        created: null,
        past: [],
        editing: null,
        preview: null,
        confirming: null,
        selected: [],
        toasts: [],

        unsaved: null,
        saveError: null,

        load(docs, force) {
          const s = get();
          // Work not saved yet (a save that failed, or one a restart cut off) is
          // the board, whatever the documents say, and it's written again.
          if (s.unsaved) {
            if (!s.loaded) {
              set({ stacks: s.unsaved, loaded: true, past: [] });
              get().retrySave();
            }
            return;
          }
          // While the board's own writes are out, a change is theirs.
          if (!force && pending) return;
          if (!force && s.loaded && !writes(plan(s.stacks, docs, "", ""))) return;
          set({ stacks: toBoard(docs), loaded: true, ...(s.loaded && !force ? {} : { past: [] }) });
        },

        retrySave() {
          if (pending || stale || !get().unsaved) return;
          void save(get().stacks).then((stacks) => stacks !== get().stacks && set({ stacks }));
        },

        async loadRepos() {
          try {
            const list = await backend.listGithubRepos();
            set({ repos: list.repos });
          } catch {
            set({ repos: [] });
          }
        },

        canPlace(modules, stackId, from) {
          const stack = get().stacks.find((s) => s.id === stackId);
          if (!stack) return { ok: false };
          if (from.kind === "stack" && from.stackId === stackId) return { ok: false, why: "Already in this stack" };
          const r = place(stack, modules);
          return r.ok ? { ok: true, replaces: r.replaced.length ? replacing(r.replaced) : undefined } : r;
        },

        placeModules(modules, from, stackId, move) {
          const s = get();
          let list = s.stacks;
          const moving = landing(modules, from, move, list);
          if (from.kind === "stack" && move) list = without(list, from.stackId, modules.map((m) => m.id));
          let gone: Deleted[] = [];
          list = list.map((st) => {
            if (st.id !== stackId) return st;
            const r = place(st, moving);
            if (!r.ok) return st;
            // What it replaced waits in Recently deleted.
            gone = r.replaced.map((module) => ({ what: "module" as const, id: uid("d"), module, from: stackName(st), at: Date.now() }));
            return r.stack;
          });
          if (!move && from.kind === "stack") list = nameCopiedExtensions(list, stackId, moving.find((m) => m.layer === "extensions")?.id);
          commit({ stacks: list, deleted: [...gone, ...takeFromDeleted(s.deleted, from)] });
          if (gone.length) get().toast(`Replaced ${gone.length === 1 ? `a ${LAYER_INFO[gone[0].what === "module" ? gone[0].module.layer : "template"].label}` : `${gone.length} modules`}: it's in Recently deleted`, true);
        },

        canStart(modules, base) {
          const r = place({ id: "", templates: [] }, onBase(modules, base ?? []));
          return r.ok ? { ok: true } : r;
        },

        newStack(modules, from, at, move, base) {
          const s = get();
          const made = fresh(onBase(landing(modules, from, move, s.stacks), base ?? []));
          // In first, then off its old stack, so `at` still means the gap it was dropped in.
          let list = [...s.stacks.slice(0, at), made, ...s.stacks.slice(at)];
          if (from.kind === "stack" && move) list = without(list, from.stackId, modules.map((m) => m.id));
          if (!move && from.kind === "stack") list = nameCopiedExtensions(list, made.id, made.extensions?.id);
          commit({ stacks: list, deleted: takeFromDeleted(s.deleted, from) });
        },

        deleteModules(modules, from) {
          if (from.kind !== "stack") return;
          // The whole stack (a Shift+drag, or its last module): ask first.
          const all = modulesOf(get().stacks.find((x) => x.id === from.stackId) ?? { id: "", templates: [] });
          if (all.every((m) => modules.some((x) => x.id === m.id))) return set({ confirming: { ids: all.map((m) => m.id) } });
          const s = get();
          const name = sourceName(s.stacks, from);
          commit({
            stacks: without(s.stacks, from.stackId, [modules[0].id]),
            deleted: [{ what: "module", id: uid("d"), module: modules[0], from: name, at: Date.now() }, ...s.deleted],
          });
          get().toast(`Moved ${title(modules[0])} to Recently deleted`, true);
        },

        async deleteForever(ids) {
          const s = get();
          const going = s.deleted.filter((d) => ids.includes(d.id));
          const staying = s.deleted.filter((d) => !ids.includes(d.id));
          set({ deleted: staying });
          // A document something still has (a stack on the board, an entry left here) stays.
          const kept = (layer: "template" | "extensions", ref: string) =>
            s.stacks.some((st) => (layer === "template" ? st.templates.some((t) => t.ref === ref) : st.extensions?.ref === ref)) ||
            staying.some((d) => d.what === "module" && d.module.layer === layer && d.module.ref === ref);
          const app = useApp.getState();
          const purge: { kind: "wadspace" | "extensions" | "template"; id: string; depth: number }[] = [];
          for (const d of going) {
            if (d.what !== "module") continue;
            const m = d.module;
            if (m.layer === "customization") {
              const stackId = m.id.split("@")[1];
              const w = app.wadspaces.find((x) => x.id === stackId);
              if (w?.deletedAt && !s.stacks.some((st) => st.id === stackId)) purge.push({ kind: "wadspace", id: stackId, depth: 0 });
            } else if (m.ref && !kept(m.layer, m.ref)) {
              // Templates top of the chain first: one under another goes after it.
              let depth = 0;
              for (let t = app.templates.find((x) => x.id === m.ref); t?.parent; t = app.templates.find((x) => x.id === t!.parent)) depth--;
              purge.push({ kind: m.layer === "template" ? "template" : "extensions", id: m.ref, depth: m.layer === "template" ? 10 + depth : 1 });
            }
          }
          purge.sort((a, b) => a.depth - b.depth);
          const failed: string[] = [];
          for (const p of [...new Map(purge.map((p) => [`${p.kind}:${p.id}`, p])).values()]) {
            try {
              await app.purge(p.kind, p.id);
            } catch (e) {
              failed.push((e as Error).message);
            }
          }
          get().toast(failed.length ? `Deleted for good, except: ${failed.join(" ")}` : `Deleted ${going.length === 1 ? "it" : `${going.length}`} for good`);
        },
        deleteIds(ids) {
          const s = get();
          let stacks = s.stacks;
          const gone: Deleted[] = [];
          for (const st of s.stacks) {
            const mine = modulesOf(st).filter((m) => ids.includes(m.id));
            if (!mine.length) continue;
            for (const module of mine) gone.push({ what: "module", id: uid("d"), module, from: stackName(st), at: Date.now() });
            stacks = without(stacks, st.id, mine.map((m) => m.id));
          }
          set({ confirming: null, selected: [] });
          if (!gone.length) return;
          commit({ stacks, deleted: [...gone, ...s.deleted] });
          const whole = s.stacks.filter((st) => modulesOf(st).every((m) => ids.includes(m.id)));
          const one = gone.length === 1 && gone[0].what === "module" ? title(gone[0].module) : `${gone.length} modules`;
          get().toast(whole.length === 1 && gone.length === modulesOf(whole[0]).length ? `Deleted ${stackName(whole[0])}: its modules are in Recently deleted` : `Moved ${one} to Recently deleted`, true);
        },

        toggleSelect: (id) => set((s) => ({ selected: s.selected.includes(id) ? s.selected.filter((x) => x !== id) : [...s.selected, id] })),
        clearSelection: () => {
          if (get().selected.length) set({ selected: [] });
        },
        deleteSelected() {
          const { selected, stacks } = get();
          if (!selected.length) return;
          // A whole stack among them: make sure first.
          if (stacks.some((st) => modulesOf(st).every((m) => selected.includes(m.id)))) set({ confirming: { ids: selected } });
          else get().deleteIds(selected);
        },

        canPlaceSub(sub, stackId, layer, from) {
          const parent = subParent(sub.key);
          if (layer !== parent) return { ok: false, why: parent === "extensions" ? "App setups go in an Extensions module" : "This goes in a Customization module" };
          const stack = get().stacks.find((s) => s.id === stackId);
          if (!stack?.[parent]) return { ok: false };
          if (from.kind === "module" && from.stackId === stackId && from.layer === layer) return { ok: false, why: "Already in this module" };
          const name = sub.key === "vscode" ? "VS Code" : sub.key === "wadbrowser" ? "WadBrowser" : null;
          const apps = appsOf(stack);
          if (name && apps.length && !apps.includes(sub.key)) return { ok: false, why: `${name} isn't in ${stackName(stack)}'s template` };
          return { ok: true };
        },

        placeSub(sub, from, to, move) {
          const s = get();
          let stacks = s.stacks;
          let deleted = takeFromDeleted(s.deleted, from);
          if (from.kind === "module" && move) stacks = editSubs(stacks, from.stackId, from.layer, (subs) => subs.filter((x) => x.id !== sub.id));
          const placed = move || from.kind === "deleted" ? sub : cloneSub(sub);
          stacks = editSubs(stacks, to.stackId, to.layer, (subs) => {
            const old = subs.find((x) => x.key === sub.key);
            if (old) deleted = [{ what: "sub", id: uid("d"), sub: old, from: sourceName(stacks, { kind: "module", ...to }), at: Date.now() }, ...deleted];
            return [...subs.filter((x) => x.key !== sub.key), placed];
          });
          commit({ stacks, deleted });
        },

        deleteSub(sub, from) {
          const s = get();
          if (from.kind !== "module") return;
          commit({
            stacks: editSubs(s.stacks, from.stackId, from.layer, (subs) => subs.filter((x) => x.id !== sub.id)),
            deleted: [{ what: "sub", id: uid("d"), sub, from: sourceName(s.stacks, from), at: Date.now() }, ...s.deleted],
          });
          get().toast("Submodule moved to Recently deleted", true);
        },

        saveModule(e, m) {
          const s = get();
          if (e.fresh) {
            // Nothing in it: nothing to add.
            if (isBlank(m)) return get().toast(`Nothing was set up, so no ${LAYER_INFO[m.layer].label} was added`);
            // A new template with all the apps of templates already on the board builds on them.
            const chain = m.layer === "template" && !(s.stacks.find((x) => x.id === e.stackId)?.templates.length) ? chainUnder(m, s.stacks) : [];
            const modules = [...chain.map((t) => cloneModule(t, false)), m];
            // The board's first wadspace: a new stack.
            if (e.stackId === NEW) {
              commit({ stacks: [...s.stacks, fresh(modules)] });
              useTour.getState().signal("stack-created");
              if (chain.length) get().toast(`${moduleName(m)} has all the apps of ${chain.map((t) => t.name).join(" → ")}, so it's stacked on ${chain.length === 1 ? "it" : "them"}`, true);
              return;
            }
            commit({
              stacks: s.stacks.map((st) => {
                if (st.id !== e.stackId) return st;
                const r = place(st, modules);
                return r.ok ? r.stack : st;
              }),
            });
            if (chain.length) get().toast(`${moduleName(m)} has all the apps of ${chain.map((t) => t.name).join(" → ")}, so it's stacked on ${chain.length === 1 ? "it" : "them"}`, true);
            return;
          }
          // A shared template renamed (its apps unchanged) is renamed everywhere.
          const was = m.layer === "template" ? s.stacks.find((st) => st.id === e.stackId)?.templates.find((t) => t.id === m.id) : undefined;
          const shared = was && m.layer === "template" && was.name !== m.name && sameApps(was, m) ? renameTemplate(s.stacks, was, m.name) : null;
          commit({
            stacks: (shared?.stacks ?? s.stacks).map((st) => {
              if (st.id !== e.stackId) return st;
              if (m.layer !== "template") return { ...st, [m.layer]: m };
              // Templates above build on this one, so an app added here reaches them too.
              const at = st.templates.findIndex((t) => t.id === m.id);
              const added = m.apps.filter((a) => !st.templates[at]?.apps.includes(a));
              return {
                ...st,
                templates: st.templates.map((t, i) => (i === at ? m : i > at ? { ...t, apps: [...t.apps, ...added.filter((a) => !t.apps.includes(a))] } : t)),
              };
            }),
          });
          get().toast(shared && shared.count > 1 ? `Saved, and renamed ${was!.name} to ${(m as TemplateModule).name} in all ${shared.count} wadspaces that share it` : `Saved ${LAYER_INFO[m.layer].label}`, true);
        },
        rename(stackId, moduleId, name) {
          name = name.trim();
          if (!name) return null;
          const s = get();
          const mod = modulesOf(s.stacks.find((st) => st.id === stackId) ?? { id: "", templates: [] }).find((x) => x.id === moduleId);
          const clash = mod && nameClash(s.stacks, stackId, mod, name);
          if (clash) return clash;
          const t = s.stacks.find((st) => st.id === stackId)?.templates.find((x) => x.id === moduleId);
          if (t) {
            const r = renameTemplate(s.stacks, t, name);
            commit({ stacks: r.stacks });
            if (r.count > 1) get().toast(`Renamed the ${t.name} template to ${name} in all ${r.count} wadspaces that share it`, true);
            return null;
          }
          // Extensions shared by stacks (same template, same setups) are renamed together.
          const owner = s.stacks.find((st) => st.extensions?.id === moduleId);
          if (owner) {
            const sig = extSig(owner);
            const sharing = s.stacks.filter((st) => extSig(st) === sig);
            commit({ stacks: s.stacks.map((st) => (extSig(st) === sig ? { ...st, extensions: { ...st.extensions!, name } } : st)) });
            if (sharing.length > 1) get().toast(`Renamed the shared Extensions in all ${sharing.length} wadspaces that use them`, true);
            return null;
          }
          commit({
            stacks: s.stacks.map((st) => {
              if (st.id !== stackId) return st;
              if (st.customization?.id === moduleId) {
                const c = st.customization;
                const has = c.subs.some((x) => x.key === "look");
                const subs = has
                  ? c.subs.map((x) => (x.key === "look" ? { ...x, name } : x))
                  : [...c.subs, { key: "look" as const, id: uid("look"), origin: name, name, description: "", wallpaper: BLANK_WALLPAPER }];
                return { ...st, customization: { ...c, subs } };
              }
              return { ...st, templates: st.templates.map((t) => (t.id === moduleId ? { ...t, name } : t)) };
            }),
          });
          return null;
        },
        openEditor: (editing) => set({ editing }),
        closeEditor: () => set({ editing: null }),
        openPreview: (preview) => set({ preview }),
        confirm: (confirming) => set({ confirming }),

        toast(text, undo) {
          const id = uid("t");
          set((s) => ({ toasts: [...s.toasts.slice(-2), { id, text, undo }] }));
          setTimeout(() => get().dismiss(id), 5000);
        },
        dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
        undo() {
          const { past } = get();
          const prev = past[past.length - 1];
          if (!prev) return;
          set({ ...prev, past: past.slice(0, -1), toasts: [] });
          void save(prev.stacks).then((stacks) => stacks !== get().stacks && set({ stacks }));
        },
        buildStack(stackId) {
          const s = get();
          const stack = s.stacks.find((x) => x.id === stackId);
          if (!stack || isBuilding(stack)) return;
          if (!appsOf(stack).length) return get().toast(`${stackName(stack)} needs a template to build on`);
          if (problemsOf(stack).length) return get().toast(`${stackName(stack)} needs fixing first`);
          if (!stack.customization || !lookOf(stack)?.name.trim()) return get().toast(`${stackName(stack)} needs a named Customization to be built`);
          useTour.getState().signal("build-started");
          const todo = unbuiltOf(stack).length;
          const updates = updatesOf(stack).length;
          const plural = (n: number) => `${n} image${n === 1 ? "" : "s"}`;
          void useApp
            .getState()
            .buildStack(stackId)
            .then(
              (ok) =>
                ok &&
                get().toast(
                  todo
                    ? `Building ${stackName(stack)}: ${plural(todo)}`
                    : updates
                      ? `Updating ${stackName(stack)}: ${plural(updates)}, on what's under ${updates === 1 ? "it" : "them"} now`
                      : `${stackName(stack)} is installed, its images built already`,
                ),
            );
        },
        buildSelected() {
          const s = get();
          const ids = s.stacks.filter((st) => modulesOf(st).some((m) => s.selected.includes(m.id))).map((st) => st.id);
          set({ selected: [] });
          for (const id of ids) get().buildStack(id);
        },
        buildAll() {
          const s = get();
          // Not built, or built on an older base: building brings them up to date.
          const waiting = s.stacks.filter((st) => toBuildOf(st).length && !isBuilding(st));
          if (!waiting.length) return get().toast(s.stacks.some(isBuilding) ? "Everything else is built and up to date" : "Everything's built and up to date");
          const noTemplate = waiting.filter((st) => !appsOf(st).length);
          const broken = waiting.filter((st) => appsOf(st).length && problemsOf(st).length);
          const unnamed = waiting.filter((st) => appsOf(st).length && !problemsOf(st).length && !lookOf(st)?.name.trim());
          const ready = waiting.filter((st) => appsOf(st).length && !problemsOf(st).length && lookOf(st)?.name.trim());
          for (const st of ready) get().buildStack(st.id);
          const list = (xs: Stack[], what: string) => (xs.length ? [`${xs.map(stackName).join(", ")} need${xs.length === 1 ? "s" : ""} ${what}`] : []);
          const skipped = [...list(broken, "fixing"), ...list(noTemplate, "a template"), ...list(unnamed, "a named Customization")];
          const updating = ready.filter((st) => !unbuiltOf(st).length).length;
          get().toast(
            `Building ${ready.length} wadspace${ready.length === 1 ? "" : "s"}${updating ? ` (${updating} an update)` : ""}${skipped.length ? `; skipped: ${skipped.join("; ")}` : ""}`,
          );
        },
        renameKey(id, name) {
          name = name.trim();
          if (!name) return "Give it a name";
          const s = get();
          const used = s.stacks.flatMap((st) => {
            const sub = subOf(st.customization, "secrets");
            return [...Object.values(sub?.bySlot ?? {}), ...(sub?.groups ?? []).flatMap((g) => (g.key ? [g.key] : []))];
          });
          const other = [...useApp.getState().knownSignIns(), ...used].find((k) => k.id !== id && k.name.toLowerCase() === name.toLowerCase());
          if (other) return `Another key is already called ${other.name}`;
          // One key, kept in many places: rename it in each (on the machine, where it's one).
          if (backend.caps.signins)
            backend
              .updateSignIn(id, { name })
              .then(() => useApp.getState().loadSignIns())
              .catch((e) => get().toast(`Couldn't rename it on the machine: ${(e as Error).message}`));
          const swap = <K extends SecretRef | undefined>(k: K): K => (k && k.id === id ? ({ ...k, name } as K) : k);
          commit({
            stacks: s.stacks.map((st) => {
              const sub = subOf(st.customization, "secrets");
              if (!st.customization || !sub) return st;
              const next = { ...sub, bySlot: Object.fromEntries(Object.entries(sub.bySlot).map(([k, v]) => [k, swap(v)])), groups: sub.groups?.map((g) => ({ ...g, key: swap(g.key) })) };
              return { ...st, customization: { ...st.customization, subs: st.customization.subs.map((x) => (x.key === "secrets" ? next : x)) } };
            }),
          });
          return null;
        },

        async createKey(kind, base) {
          const s = get();
          const taken = new Set([...useApp.getState().knownSignIns(), ...keysOfKind([], s.stacks, kind)].map((k) => k.name.toLowerCase()));
          let name = base;
          for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base}-${n}`;
          const [key] = await useApp.getState().createSignIns([{ name, kind }]);
          if (!key) throw new Error("The key wasn't made");
          return key;
        },

        fix(stackId, f) {
          const s = get();
          const stack = s.stacks.find((st) => st.id === stackId);
          if (!stack) return;
          let next: Stack = stack;
          if (f.kind === "addApp") {
            // Onto the top template; a shared template whose apps change gets a name of its own.
            const top = stack.templates[stack.templates.length - 1];
            if (!top) return;
            const apps = [...top.apps, f.appId];
            const clash = s.stacks.some((st) => st.templates.some((t) => t.id !== top.id && t.name === top.name && !(t.apps.length === apps.length && t.apps.every((a) => apps.includes(a)))));
            let name = top.name;
            if (clash) {
              const names = s.stacks.flatMap((st) => st.templates.map((t) => t.name));
              for (let n = 1; names.includes(name); n++) name = `${top.name.replace(/ - \d+$/, "")} - ${n}`;
            }
            next = { ...stack, templates: stack.templates.map((t) => (t.id === top.id ? { ...t, apps, name } : t)) };
          } else {
            const secrets = subOf(stack.customization, "secrets");
            const bySlot = { ...(secrets?.bySlot ?? {}) };
            let groups = secrets?.groups;
            if (f.kind === "removeKey") delete bySlot[f.slot];
            else {
              for (const k of Object.keys(bySlot)) if (k === `app:${f.appId}` || (f.appId === "vscode" && k.startsWith("ext:"))) delete bySlot[k];
              if (f.appId === "wadbrowser") groups = undefined;
            }
            const ext = stack.extensions;
            next = {
              ...stack,
              extensions: f.kind === "removeApp" && ext ? { ...ext, subs: ext.subs.filter((x) => x.key !== f.appId) } : ext,
              customization: stack.customization && secrets ? { ...stack.customization, subs: stack.customization.subs.map((x) => (x.key === "secrets" ? { ...x, bySlot, groups } : x)) } : stack.customization,
            };
          }
          commit({ stacks: s.stacks.map((st) => (st.id === stackId ? next : st)) });
          get().toast(`${f.label}: done`, true);
        },

        async createProject(name) {
          name = name.trim();
          const slug = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
          if (!slug) return "Give it a name";
          if (get().repos?.some((r) => r.name.toLowerCase() === slug.toLowerCase())) return `You already have a repository called ${slug}`;
          try {
            const p = await backend.createGithubRepo({ name: slug, private: true });
            const repo = p.source.kind === "git" ? repoFullName(p.source.url) : slug;
            get().toast(`Made ${repo} on GitHub`);
            void get().loadRepos();
            return { repo };
          } catch (e) {
            return (e as Error).message;
          }
        },
        createStack() {
          const s = get();
          const names = s.stacks.flatMap((st) => st.templates.map((t) => t.name.toLowerCase()));
          let name = "New template";
          for (let n = 1; names.includes(name.toLowerCase()); n++) name = `New template - ${n}`;
          const stack: Stack = { id: uid("stack"), templates: [{ layer: "template", id: uid("template"), name, description: "", apps: [] }] };
          commit({ stacks: [...s.stacks, stack] });
          useTour.getState().signal("stack-created");
          set({ created: stack.id });
          setTimeout(() => get().created === stack.id && set({ created: null }), 1800);
          return stack.id;
        },
      };
    },
    {
      // Recently deleted is kept here (this browser's), and the board while it
      // isn't all saved; otherwise the stacks are the documents.
      name: "wadspaces.builder",
      version: 1,
      migrate: () => ({ deleted: [] }) as never,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ deleted: s.deleted, unsaved: s.unsaved }),
    },
  ),
);

/** The modules a grab takes: the one grabbed and every module on top of it, or (with Shift) just it. */
export function grab(stack: Stack, moduleId: string, only: boolean): Module[] {
  const all = modulesOf(stack);
  const at = all.findIndex((x) => x.id === moduleId);
  return at < 0 ? [] : only ? [all[at]] : all.slice(at);
}

/** The board kept in step with the documents, from wherever the app is (the
 *  Shell): so work a restart cut off is written again at start, Builder open
 *  or not, and when the network comes back. */
export function useBoardSync() {
  const loaded = useApp((s) => s.layersLoaded);
  const templates = useApp((s) => s.templates);
  const extensions = useApp((s) => s.extensions);
  const wadspaces = useApp((s) => s.wadspaces);
  useEffect(() => {
    if (loaded) useBoard.getState().load({ templates, extensions, wadspaces });
  }, [loaded, templates, extensions, wadspaces]);
  useEffect(() => {
    const again = () => useBoard.getState().retrySave();
    addEventListener("online", again);
    return () => removeEventListener("online", again);
  }, []);
}
