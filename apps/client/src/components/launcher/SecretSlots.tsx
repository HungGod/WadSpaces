// A key per slot: a new saved sign-in, one already saved of its kind, or
// none (sign in inside the app; nothing is kept on the machine).
import { KeyRound, Users } from "lucide-react";
import clsx from "clsx";
import { SECRET_KINDS } from "@core/catalog/catalog";
import { fits, type SignInRef, type Slot } from "@core/layers";
import { useApp } from "@/lib/store";
import { Input, Segmented } from "../ui";
import { choiceFor, defaultSecretName, resolvedName, type SlotChoice, type SlotDraft } from "./slots";
import { iconSrc, noIcon } from "@/lib/webIcon";

/**
 * A choice per slot: save a new secret, use one of the same kind already
 * saved (or new for another slot here, to share it), or don't save: sign in
 * inside the app and keep nothing on the machine. `dontSave` says what that
 * means where it's shown.
 */
export function SecretSlots({
  slots,
  draft: w,
  onSlot,
  dontSave = "Signs in inside this wadspace only; nothing is saved on the machine.",
}: {
  slots: Slot[];
  draft: SlotDraft;
  onSlot: (key: string, c: SlotChoice) => void;
  dontSave?: string;
}) {
  useApp((s) => s.signIns);
  useApp((s) => s.wadspaces);
  const secrets = useApp.getState().knownSignIns();
  /** Which slots end up with each secret, to show what's shared. */
  const sharing = new Map<string, Slot[]>();
  for (const s of slots) {
    const name = resolvedName(w, s);
    if (name) sharing.set(name, [...(sharing.get(name) ?? []), s]);
  }

  const allUnsaved = slots.every((s) => choiceFor(w, s).mode === "none");
  return (
    <div className="space-y-2">
      {slots.length > 1 && (
        <div className="flex justify-end">
          <button type="button" disabled={allUnsaved} onClick={() => slots.forEach((s) => onSlot(s.key, { mode: "none", name: "" }))} className="text-xs font-medium text-accent hover:underline disabled:text-faint disabled:no-underline">
            Don&apos;t save any
          </button>
        </div>
      )}
      {slots.map((slot) => (
        <SlotRow key={slot.key} slot={slot} slots={slots} w={w} saved={secrets.filter((s) => fits(s, slot))} sharedWith={(sharing.get(resolvedName(w, slot) ?? "") ?? []).filter((s) => s.key !== slot.key)} dontSave={dontSave} onChange={(c) => onSlot(slot.key, c)} />
      ))}
    </div>
  );
}

function SlotRow({ slot, slots, w, saved, sharedWith, dontSave, onChange }: { slot: Slot; slots: Slot[]; w: SlotDraft; saved: SignInRef[]; sharedWith: Slot[]; dontSave: string; onChange: (c: SlotChoice) => void }) {
  const choice = choiceFor(w, slot);
  // Reusable here: saved secrets of this kind, and ones this wadspace is about to save for another slot of the kind.
  const pending = [...new Set(slots.filter((s) => s.key !== slot.key && s.kind === slot.kind && choiceFor(w, s).mode === "new").map((s) => resolvedName(w, s)!))].filter(
    (n) => !saved.some((x) => x.name.toLowerCase() === n.toLowerCase()),
  );
  const options: { value: string; label: string; pick: SlotChoice }[] = [...saved.map((s) => ({ value: `id:${s.id}`, label: s.name, pick: { mode: "existing" as const, name: s.name, id: s.id } })), ...pending.map((n) => ({ value: `new:${n}`, label: `${n} (new here)`, pick: { mode: "existing" as const, name: n } }))];
  const current = choice.mode === "existing" ? (choice.id ? `id:${choice.id}` : `new:${choice.name}`) : "";
  // A saved pick the machine doesn't list (online, one not made there yet) stays offered.
  if (choice.mode === "existing" && choice.id && !options.some((o) => o.value === current)) options.unshift({ value: current, label: choice.name, pick: { mode: "existing", name: choice.name, id: choice.id } });
  return (
    <div className="rounded-2xl bg-surface-2/50 p-3 ring-1 ring-line">
      <div className="flex items-center gap-2.5">
        <img src={iconSrc(slot.iconUrl)} onError={noIcon} alt="" className="size-5 shrink-0 object-contain" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{slot.label}</div>
          <div className="truncate text-[11px] text-muted">{SECRET_KINDS[slot.kind].label}</div>
        </div>
        <Segmented
          value={choice.mode}
          onChange={(mode) =>
            onChange(
              mode === "existing"
                ? (options.find((o) => o.value === current)?.pick ?? options[0]?.pick ?? { mode: "existing", name: "" })
                : { mode, name: mode === "new" && choice.mode === "new" ? choice.name : "" },
            )
          }
          options={[
            { value: "new", label: "New" },
            { value: "existing", label: "Existing" },
            { value: "none", label: "Don't save" },
          ]}
        />
      </div>
      {choice.mode === "new" && (
        <div className="mt-2 flex items-center gap-2">
          <KeyRound className="size-3.5 shrink-0 text-faint" />
          <Input value={choice.name} onChange={(e) => onChange({ mode: "new", name: e.target.value })} placeholder={defaultSecretName(w, slot)} className="h-8 font-mono text-[12px]" aria-label={`New secret for ${slot.label}`} />
        </div>
      )}
      {choice.mode === "existing" &&
        (options.length ? (
          <select
            value={current}
            onChange={(e) => {
              const o = options.find((x) => x.value === e.target.value);
              if (o) onChange(o.pick);
            }}
            className="mt-2 h-8 w-full rounded-lg bg-surface px-2 font-mono text-[12px] text-fg outline-none ring-1 ring-line focus:ring-accent"
            aria-label={`Existing secret for ${slot.label}`}
          >
            {!current && <option value="">Pick one</option>}
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ) : (
          <p className="mt-2 text-xs text-muted">No {SECRET_KINDS[slot.kind].label.toLowerCase()}s saved yet: only those can be mounted here.</p>
        ))}
      {choice.mode === "none" && <p className="mt-2 text-xs text-muted">{dontSave}</p>}
      {sharedWith.length > 0 && (
        <p className={clsx("mt-2 flex items-center gap-1.5 text-xs text-accent")}>
          <Users className="size-3.5" /> Shared with {sharedWith.map((s) => s.label).join(", ")}
        </p>
      )}
    </div>
  );
}
