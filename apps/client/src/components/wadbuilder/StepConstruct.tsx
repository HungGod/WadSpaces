// Step 3: WadSpaces construction. What makes it this wadspace rather than its
// template: a name, a background, project folders, and secrets for the apps
// that keep sign-ins. None of it is in an image: it's mounted at start.
import { History, KeyRound, Users } from "lucide-react";
import clsx from "clsx";
import { SECRET_KINDS } from "@core/catalog/catalog";
import { fits, imageKey, opensFolders, resolve, slotsFor, type SignInRef, type Slot } from "@core/layers";
import { useApp } from "@/lib/store";
import { useTour } from "@/lib/tour";
import { ProjectsPanel } from "./ProjectsPanel";
import { Input, Label, Segmented, Textarea } from "../ui";
import { WallpaperPicker } from "../WallpaperPicker";
import { asChoices, choiceFor, defaultSecretName, resolvedName, resolveSlots, signInRefs, useDraft, type SlotChoice, type SlotDraft } from "./draft";
import { BuildButton, Heading, ImageBadge, useImageState } from "./parts";

export function StepConstruct() {
  const base = useDraft((s) => s.base);
  const setup = useDraft((s) => s.setup);
  const w = useDraft((s) => s.wadspace);
  const setWadspace = useDraft((s) => s.setWadspace);
  const templates = useApp((s) => s.templates);
  const customizations = useApp((s) => s.customizations);
  const legacy = useApp((s) => (w.id ? s.wadspaces.find((x) => x.id === w.id)?.legacyImage : null));
  const r = base && resolve({ templates, customizations }, base);
  if (!r || !setup || !base) return null;
  const slots = slotsFor(r.template, setup);

  return (
    <div className="space-y-7 p-5" data-tour="step-construct">
      {legacy && <BuiltBefore image={legacy} layer={imageKey(base)} />}
      <div className="flex items-center gap-3 rounded-2xl bg-surface-2/50 p-3 ring-1 ring-line">
        <div className="min-w-0 flex-1">
          <div className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-faint">Runs on</div>
          <div className="truncate text-sm font-semibold">{r.customization ? `${r.customization.name} (${r.template.name})` : `${r.template.name} template`}</div>
          <div className="mt-1">
            <ImageBadge image={imageKey(base)} />
          </div>
        </div>
        <BuildButton image={imageKey(base)} />
      </div>

      <section className="space-y-3">
        <div>
          <Label>Name</Label>
          <Input value={w.name} onChange={(e) => setWadspace({ name: e.target.value })} placeholder="e.g. VanuaAcademy" />
        </div>
        <div>
          <Label>Description</Label>
          <Textarea value={w.description} onChange={(e) => setWadspace({ description: e.target.value })} rows={2} placeholder="What it's for" />
        </div>
      </section>

      <section id="wallpaper">
        <Heading>Background</Heading>
        <WallpaperPicker value={w.wallpaper} onChange={(wallpaper) => setWadspace({ wallpaper })} />
      </section>

      <section>
        <Heading
          hint={
            opensFolders(r.template)
              ? "Mounted read-write at ~/Desktop/<folder> when it starts; each shows as a folder on the desktop that opens in VS Code."
              : `Mounted read-write at ~/Desktop/<folder> when it starts. Nothing in ${r.template.name} opens a folder in a window, so they get no desktop icon: open them from its apps.`
          }
        >
          Project folders
        </Heading>
        <div className="-mx-1">
          <ProjectsPanel value={w.projects} onChange={(projects) => setWadspace({ projects })} />
        </div>
      </section>

      <section data-tour="secrets">
        <Heading hint="Saved sign-ins, kept on the machine and mounted into this wadspace. Save a new one, or reuse one of the same kind.">Secrets</Heading>
        {slots.length ? <SecretsPanel slots={slots} /> : <p className="text-xs text-muted">Nothing in this template keeps a sign-in.</p>}
      </section>
    </div>
  );
}

/** A wadspace from before the layers: it runs its old image until its layer's is built. */
function BuiltBefore({ image, layer }: { image: string; layer: ReturnType<typeof imageKey> }) {
  const state = useImageState(layer);
  return (
    <div className="flex items-center gap-3 rounded-2xl bg-accent-2/10 p-3 ring-1 ring-accent-2/40">
      <History className="size-5 shrink-0 text-accent-2" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold">Built from before layers</div>
        <div className="text-xs text-muted">{state === "building" ? "Its new image is building: it switches when that's done." : "It runs its old image until you build its new one, then switches."}</div>
        <div className="truncate font-mono text-[11px] text-faint">{image}</div>
      </div>
      <BuildButton image={layer} />
    </div>
  );
}

function SecretsPanel({ slots }: { slots: Slot[] }) {
  const w = useDraft((s) => s.wadspace);
  const setSlot = useDraft((s) => s.setSlot);
  return <SecretSlots slots={slots} draft={w} onSlot={setSlot} />;
}

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
        <img src={slot.iconUrl} alt="" className="size-5 shrink-0 object-contain" />
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

/** Saving Step 3: the wadspace, and the new secrets it names. */
export function useConstructSave() {
  const base = useDraft((s) => s.base);
  const setup = useDraft((s) => s.setup);
  const w = useDraft((s) => s.wadspace);
  const setWadspace = useDraft((s) => s.setWadspace);
  const templates = useApp((s) => s.templates);
  const customizations = useApp((s) => s.customizations);
  const wadspaces = useApp((s) => s.wadspaces);
  useApp((s) => s.signIns);
  const saveWadspace = useApp((s) => s.saveWadspace);
  const r = base && resolve({ templates, customizations }, base);
  const slots = r && setup ? slotsFor(r.template, setup) : [];
  const resolved = resolveSlots(w, slots, useApp.getState().knownSignIns());
  const taken = !!w.name.trim() && wadspaces.some((x) => x.id !== w.id && x.name.trim().toLowerCase() === w.name.trim().toLowerCase());
  const problems = [...(taken ? [`There's a wadspace called ${w.name.trim()} already.`] : []), ...resolved.problems];

  const save = async () => {
    if (!base) return null;
    try {
      const secrets = await signInRefs(resolved);
      const saved = await saveWadspace({ id: w.id, name: w.name.trim(), description: w.description.trim(), base, wallpaper: w.wallpaper, projects: w.projects, secrets });
      // From here on its secrets are saved ones.
      setWadspace({ id: saved.id, secrets: asChoices(secrets) });
      useTour.getState().signal("wadspace-saved");
      return saved;
    } catch (e) {
      useApp.getState().toast({ title: "Couldn't save the wadspace", body: (e as Error).message, tone: "error" });
      return null;
    }
  };
  return { save, problems, canSave: !!w.name.trim() && !problems.length };
}
