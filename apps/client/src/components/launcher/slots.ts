// Keys picked per slot, in the launcher's runs and WadBrowser setups: a new
// saved sign-in (named after the run or setup unless a name is typed), one
// already saved of the same kind (by its id), or none. Using them makes the
// new ones first and keeps a SignInRef per slot.
import { newSecretName, type SecretKind, type SignInRef, type Slot } from "@core/layers";
import { SECRET_KINDS } from "@core/catalog/catalog";
import { useApp } from "@/lib/store";

/** What a slot keeps: nothing, a new secret (empty name: the default), or one
 *  already saved (its id), or new for another slot in this draft (its name, no id). */
export interface SlotChoice {
  mode: "none" | "new" | "existing";
  name: string;
  id?: string;
}

/** What secret choices hang off: a name (for new secrets' default names) and a choice per slot. A wadspace or a WadBrowser run.
 *  `defaultName` overrides how a new secret is named when none is typed. */
export interface SlotDraft {
  name: string;
  secrets: Record<string, SlotChoice>;
  defaultName?: (slot: Slot) => string;
}

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
export interface ResolvedSlot {
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
  const refs: Record<string, ResolvedSlot> = {};
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
