// The Builder's work in progress, step to step: what it starts from (Step 1),
// the setup being customized (Step 2), and the wadspace being constructed
// (Step 3). Nothing here is saved until a step saves it to the store.
//
// Secrets are picked per slot: a new saved sign-in (named for the wadspace
// unless a name is typed), one already saved of the same kind (by its id), or
// none. Saving makes the new ones first and keeps a SignInRef per slot.
import { create } from "zustand";
import { newSecretName, resolve, setupOf, type BaseRef, type Library, type SecretKind, type Setup, type SignInRef, type Slot, type Wadspace } from "@core/layers";
import { SECRET_KINDS } from "@core/catalog/catalog";
import { DEFAULT_WALLPAPER } from "@/components/desktop/wallpapers";
import { useApp } from "@/lib/store";
import type { Wallpaper } from "@/lib/types";

export type Step = "template" | "customize" | "construct";

/** What a slot keeps: nothing, a new secret (empty name: the default), or one
 *  already saved (its id), or new for another slot in this draft (its name, no id). */
export interface SlotChoice {
  mode: "none" | "new" | "existing";
  name: string;
  id?: string;
}

export interface WadspaceDraft {
  id?: string;
  name: string;
  description: string;
  wallpaper: Wallpaper;
  projects: string[];
  secrets: Record<string, SlotChoice>;
}

const blankWadspace = (): WadspaceDraft => ({ name: "", description: "", wallpaper: DEFAULT_WALLPAPER, projects: [], secrets: {} });

interface DraftState {
  step: Step;
  /** The template whose stack's picker is open in Step 1 (Home opens it too). */
  picking: string | null;
  base: BaseRef | null;
  setup: Setup | null;
  wadspace: WadspaceDraft;
  /** Start from a template or a customization: on to Step 2. */
  begin: (base: BaseRef, lib: Library) => void;
  /** Open a saved wadspace, with its base and secrets. Like every start, it begins on Step 2. */
  edit: (w: Wadspace, lib: Library) => void;
  /** A new wadspace starting from a saved one: its base, background, projects and secrets, but a name of its own. */
  copy: (w: Wadspace, lib: Library) => void;
  /** After saving a customization: the draft now builds on it. */
  rebase: (base: BaseRef, setup: Setup) => void;
  setSetup: (patch: Partial<Setup>) => void;
  setWadspace: (patch: Partial<WadspaceDraft>) => void;
  setSlot: (key: string, choice: SlotChoice) => void;
  goto: (step: Step) => void;
  pick: (templateId: string | null) => void;
  reset: () => void;
}

export const useDraft = create<DraftState>((set, get) => ({
  step: "template",
  picking: null,
  base: null,
  setup: null,
  wadspace: blankWadspace(),
  begin: (base, lib) => {
    const r = resolve(lib, base);
    if (!r) return;
    set({ step: "customize", base, setup: r.setup, wadspace: blankWadspace() });
  },
  edit: (w, lib) => {
    const r = resolve(lib, w.base);
    if (!r) return;
    set({ step: "customize", base: w.base, setup: r.setup, wadspace: fromSaved(w) });
  },
  copy: (w, lib) => {
    const r = resolve(lib, w.base);
    if (!r) return;
    set({ step: "customize", base: w.base, setup: r.setup, wadspace: { ...fromSaved(w), id: undefined, name: "" } });
  },
  rebase: (base, setup) => set({ base, setup: setupOf(setup) }),
  setSetup: (patch) => {
    const s = get().setup;
    if (s) set({ setup: { ...s, ...patch } });
  },
  setWadspace: (patch) => set({ wadspace: { ...get().wadspace, ...patch } }),
  setSlot: (key, choice) => set({ wadspace: { ...get().wadspace, secrets: { ...get().wadspace.secrets, [key]: choice } } }),
  goto: (step) => set({ step }),
  // Opening a picker goes back to Step 1, where it is; closing one stays put.
  pick: (picking) => set(picking ? { step: "template", picking } : { picking }),
  reset: () => set({ step: "template", base: null, setup: null, wadspace: blankWadspace() }),
}));

export function fromSaved(w: Pick<Wadspace, "id" | "name" | "description" | "wallpaper" | "projects" | "secrets">): WadspaceDraft {
  return { id: w.id, name: w.name, description: w.description, wallpaper: w.wallpaper, projects: w.projects, secrets: asChoices(w.secrets) };
}

/** What secret choices hang off: a name (for new secrets' default names) and a choice per slot. A wadspace or a WadBrowser run.
 *  `defaultName` overrides how a new secret is named when none is typed. */
export type SlotDraft = Pick<WadspaceDraft, "name" | "secrets"> & { defaultName?: (slot: Slot) => string };

/** What a new secret is called when no name is typed: <name>-<app id>, unless the draft says otherwise. */
export const defaultSecretName = (w: SlotDraft, slot: Slot) => w.defaultName?.(slot) ?? newSecretName(w.name, slot);

/** A slot's choice: what the draft says, else a new secret (the default). */
export const choiceFor = (w: SlotDraft, slot: Slot): SlotChoice => w.secrets[slot.key] ?? { mode: "new", name: "" };

/** The secret name a slot ends up with, or null for none. */
export function resolvedName(w: SlotDraft, slot: Slot): string | null {
  const c = choiceFor(w, slot);
  if (c.mode === "none") return null;
  if (c.mode === "existing") return c.name || null;
  return c.name.trim() || defaultSecretName(w, slot);
}

/** A slot's secret once resolved: a saved one (with its id) or one to make. */
export interface Resolved {
  name: string;
  kind: SecretKind;
  id?: string;
}

/** Each slot's secret, the new ones to make, and what's wrong (an unknown
 *  pick, or one name for two kinds). `saved`: the sign-ins that can be picked. */
export function resolveSlots(w: SlotDraft, slots: Slot[], saved: SignInRef[]) {
  const problems: string[] = [];
  const byName = new Map(saved.map((s) => [s.name.toLowerCase(), s]));
  const byId = new Map(saved.map((s) => [s.id, s]));
  const freshNames = new Set(slots.filter((s) => choiceFor(w, s).mode === "new").map((s) => resolvedName(w, s)!.toLowerCase()));
  const refs: Record<string, Resolved> = {};
  const fresh: { name: string; kind: SecretKind }[] = [];
  const kinds = new Map<string, SecretKind>(saved.map((s) => [s.name.toLowerCase(), s.kind]));
  for (const s of slots) {
    const c = choiceFor(w, s);
    // A saved one has its id (online, perhaps not on the machine yet); a
    // pick by name is one this draft is about to save for another slot.
    if (c.mode === "existing" && !c.id && !freshNames.has(c.name.toLowerCase())) problems.push(`Pick a secret for ${s.label}, or save a new one.`);
  }
  for (const s of slots) {
    const c = choiceFor(w, s);
    const name = resolvedName(w, s);
    if (!name) continue;
    const key = name.toLowerCase();
    const k = kinds.get(key);
    if (k && k !== s.kind) {
      problems.push(`"${name}" is a ${SECRET_KINDS[k]?.label.toLowerCase() ?? k}; ${s.label} needs a ${SECRET_KINDS[s.kind].label.toLowerCase()}.`);
      continue;
    }
    kinds.set(key, s.kind);
    // A saved one (picked, or a new name that's saved already), else one to make.
    const known = (c.mode === "existing" && c.id && byId.get(c.id)) || byName.get(key);
    if (c.mode === "existing" && c.id && !known) refs[s.key] = { id: c.id, name, kind: s.kind };
    else if (known) refs[s.key] = { id: known.id, name: known.name, kind: s.kind };
    else {
      refs[s.key] = { name, kind: s.kind };
      if (!fresh.some((f) => f.name.toLowerCase() === key)) fresh.push({ name, kind: s.kind });
    }
  }
  return { refs, fresh, problems };
}

/** Makes the new sign-ins a draft names (once each) and gives every slot its ref. */
export async function signInRefs({ refs, fresh }: Pick<ReturnType<typeof resolveSlots>, "refs" | "fresh">): Promise<Record<string, SignInRef>> {
  const made = await useApp.getState().createSignIns(fresh);
  const byName = new Map(made.map((m) => [m.name.toLowerCase(), m]));
  const out: Record<string, SignInRef> = {};
  for (const [key, r] of Object.entries(refs)) {
    const id = r.id ?? byName.get(r.name.toLowerCase())?.id;
    if (id) out[key] = { id, name: r.id ? r.name : (byName.get(r.name.toLowerCase())?.name ?? r.name), kind: r.kind };
  }
  return out;
}

/** Saved secrets as choices: what a saved wadspace or WadBrowser setup already uses. */
export const asChoices = (secrets: Record<string, SignInRef>): Record<string, SlotChoice> =>
  Object.fromEntries(Object.entries(secrets).map(([k, r]) => [k, { mode: "existing", name: r.name, id: r.id }]));
