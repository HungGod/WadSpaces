// The launcher (bottom of the sidebar). Two areas:
//
//   Wadspaces        the spaces, each its own desktop
//   On this machine  WadBrowser (and Focus, and saved WadBrowser setups) and
//                    the terminal, which run on the machine beside the spaces
//
// Pick any mix, then launch, or launch in focus mode for a set time. A
// wadspace or a WadBrowser can be customized first (the sliders): only what a
// run changes (a wadspace's background, folders and secrets; WadBrowser's
// mode, web apps and their sign-ins), then saved, or run once and thrown away.
// The terminal has nothing to customize.
//
// Online, it launches on the machine picked in its header (the account's
// default machine), through the relay.
import { useState } from "react";
import { Check, Lock, Play, Plus, SlidersHorizontal, Timer, Trash2, X } from "lucide-react";
import clsx from "clsx";
import { browserSlots, desktopFor, imageKey, knownWebapps, named, opensFolders, resolve, slotsFor, webappIcon, webappId, type BrowserSetup, type SignInRef, type WadspaceV2, type WebApp } from "@core/layers";
import { backend } from "@/data";
import { DEFAULT_BROWSERS, type BrowserConfig, type RunItem, type RunOverrides } from "@/data/layers";
import { clockTime } from "@/lib/format";
import { TARGET } from "@/lib/machine";
import { alive, useApp } from "@/lib/store";
import { DesktopThumb } from "../desktop/DesktopThumb";
import { Badge, Button, IconButton, Input, Label, Modal, Textarea } from "../ui";
import { WallpaperPicker } from "../WallpaperPicker";
import { asChoices, fromSaved, resolveSlots, signInRefs, type SlotChoice, type WadspaceDraft } from "./draft";
import { Choice, Heading, useImageState } from "./parts";
import { ProjectsPanel } from "./ProjectsPanel";
import { SecretSlots } from "./StepConstruct";

const PRESETS = [25, 50, 90, 120];
const fmtMinutes = (m: number) => (m < 60 ? `${m} min` : m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} h`);
const BROWSER_ICON = "/brand/wadbrowser-icon-dark.svg";
const TERMINAL_ICON = "/catalog/terminal.png";

/** Something in the launcher to pick: a saved wadspace or WadBrowser setup, the terminal, or a throwaway run. */
interface Entry {
  id: string;
  item: RunItem;
  label: string;
  /** A throwaway run: listed until the launcher closes. */
  once?: boolean;
}

/** The launcher. `customize`: open straight into customizing this wadspace for a run. */
export function LaunchDialog({ open, onClose, customize }: { open: boolean; onClose: () => void; customize?: string }) {
  return (
    <Modal open={open} onClose={onClose} width={920} title="Launch" subtitle="Pick spaces and apps to open together.">
      {open && <Flow onClose={onClose} customize={customize} />}
    </Modal>
  );
}

/** Online: the machine it launches on (the account's default). */
function MachinePicker() {
  const machines = useApp((s) => s.machines);
  const target = useApp((s) => s.launchTarget);
  if (TARGET !== "online" || machines.length < 2) return null;
  return (
    <div className="flex items-center gap-2 text-xs text-muted">
      Launch on
      <select
        value={target}
        onChange={(e) => {
          backend.setDefaultMachine?.(e.target.value);
          useApp.getState().setLaunchTarget(e.target.value);
        }}
        className="h-8 rounded-lg bg-surface-2 px-2 text-[13px] text-fg outline-none ring-1 ring-line focus:ring-accent"
        aria-label="Machine"
      >
        {machines.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
            {m.status === "offline" ? " (offline)" : ""}
          </option>
        ))}
      </select>
    </div>
  );
}

type Customizing = { kind: "wadspace"; w: WadspaceV2 } | { kind: "browser"; base: BrowserConfig; savedId?: string } | null;

function Flow({ onClose, customize }: { onClose: () => void; customize?: string }) {
  const all = useApp((s) => s.wadspaces);
  const allBrowsers = useApp((s) => s.browsers);
  const remove = useApp((s) => s.remove);
  const launch = useApp((s) => s.launch);
  const wadspaces = alive(all);
  const browsers = alive(allBrowsers);
  const [picked, setPicked] = useState<string[]>([]);
  const [once, setOnce] = useState<Entry[]>([]);
  const [customizing, setCustomizing] = useState<Customizing>(() => {
    const w = customize ? wadspaces.find((x) => x.id === customize) : undefined;
    return w ? { kind: "wadspace", w } : null;
  });
  const [focus, setFocus] = useState(false);
  const [minutes, setMinutes] = useState(50);
  const [going, setGoing] = useState(false);

  const spaces: Entry[] = [
    ...wadspaces.map((w) => ({
      id: `w:${w.id}`,
      item: { kind: "wadspace" as const, wadspaceId: w.id },
      label: w.name,
    })),
    ...once.filter((e) => e.item.kind === "wadspace"),
  ];
  const apps: Entry[] = [
    ...DEFAULT_BROWSERS.map((b) => ({
      id: `b:${b.id}`,
      item: { kind: "browser" as const, config: b },
      label: b.name,
    })),
    ...browsers.map((b) => ({
      id: `b:${b.id}`,
      item: { kind: "browser" as const, config: configOf(b), savedId: b.id },
      label: b.name,
    })),
    ...once.filter((e) => e.item.kind === "browser"),
    { id: "terminal", item: { kind: "terminal" }, label: "Terminal" },
  ];
  const entries = [...spaces, ...apps];
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const addOnce = (e: Omit<Entry, "id" | "once">) => {
    const id = `once:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    setOnce((o) => [...o, { ...e, id, once: true }]);
    setPicked((p) => [...p, id]);
    setCustomizing(null);
  };
  const go = async (focusMinutes: number | null) => {
    setGoing(true);
    // Spaces first, then what runs on the machine beside them.
    const items = picked.flatMap((id) => entries.find((e) => e.id === id)?.item ?? []);
    const ordered = [...items.filter((i) => i.kind === "wadspace"), ...items.filter((i) => i.kind !== "wadspace")];
    const ok = await launch(ordered, focusMinutes);
    setGoing(false);
    if (ok) onClose();
  };

  if (customizing?.kind === "wadspace")
    return (
      <WadspaceRun
        w={customizing.w}
        onCancel={() => setCustomizing(null)}
        onRun={(overrides) =>
          addOnce({
            item: { kind: "wadspace", wadspaceId: customizing.w.id, overrides },
            label: `${customizing.w.name} (run)`,
          })
        }
        onSaved={(w) => {
          setPicked((p) => [...p, `w:${w.id}`]);
          setCustomizing(null);
        }}
      />
    );
  if (customizing?.kind === "browser")
    return (
      <BrowserRun
        base={customizing.base}
        savedId={customizing.savedId}
        onCancel={() => setCustomizing(null)}
        onRun={(config) =>
          addOnce({
            item: { kind: "browser", config },
            label: `${config.name} (run)`,
          })
        }
        onSaved={(b) => {
          setPicked((p) => (p.includes(`b:${b.id}`) ? p : [...p, `b:${b.id}`]));
          setCustomizing(null);
        }}
      />
    );

  if (focus) {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    const set = (h: number, m: number) => setMinutes(Math.min(12 * 60, Math.max(1, h * 60 + m)));
    return (
      <div className="space-y-5">
        <div>
          <Label hint={`until about ${clockTime(Date.now() + minutes * 60_000)}`}>Focus for how long?</Label>
          <div className="flex flex-wrap items-center gap-2">
            {PRESETS.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMinutes(m)}
                className={clsx("h-10 rounded-xl px-4 text-sm font-medium ring-1 transition-colors", minutes === m ? "bg-accent text-accent-fg ring-accent" : "bg-surface-2 ring-line hover:ring-line-strong")}
              >
                {fmtMinutes(m)}
              </button>
            ))}
            <div className="flex items-center gap-1.5">
              <Input type="number" min={0} max={12} value={hours} onChange={(e) => set(Number(e.target.value) || 0, mins)} className="!w-16 text-center" aria-label="Hours" />
              <span className="text-sm text-muted">h</span>
              <Input type="number" min={0} max={59} step={5} value={mins} onChange={(e) => set(hours, Math.min(59, Number(e.target.value) || 0))} className="!w-16 text-center" aria-label="Minutes" />
              <span className="text-sm text-muted">min</span>
            </div>
          </div>
        </div>
        <p className="text-xs text-muted">Only these {picked.length} open until the time&apos;s up, and there&apos;s no ending it early.</p>
        <div className="flex items-center gap-2 border-t border-line pt-4">
          <Button variant="ghost" onClick={() => setFocus(false)} className="mr-auto">
            Back
          </Button>
          <Button variant="primary" disabled={going} onClick={() => void go(minutes)}>
            <Timer className="size-4" /> Start focus for {fmtMinutes(minutes)}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <MachinePicker />
      <div className="max-h-[62vh] space-y-6 overflow-y-auto pr-1">
        <section>
          <Heading hint="Each its own desktop. Customize one to change its background, folders or secrets for a run.">Wadspaces</Heading>
          {spaces.length ? (
            <div className="grid gap-2 sm:grid-cols-2">
              {spaces.map((e) => {
                const item = e.item;
                const w = item.kind === "wadspace" ? wadspaces.find((x) => x.id === item.wadspaceId) : undefined;
                if (!w) return null;
                return (
                  <SpaceCard
                    key={e.id}
                    entry={e}
                    w={w}
                    on={picked.includes(e.id)}
                    onToggle={() => toggle(e.id)}
                    onCustomize={e.once ? undefined : () => setCustomizing({ kind: "wadspace", w })}
                    onRemove={e.once ? () => setOnce((o) => o.filter((x) => x.id !== e.id)) : undefined}
                  />
                );
              })}
            </div>
          ) : (
            <p className="rounded-2xl bg-surface-2 px-4 py-3 text-sm text-muted ring-1 ring-line">No wadspaces yet. Make one in the Builder.</p>
          )}
        </section>

        <section>
          <Heading hint="On the machine itself, beside the spaces. Run as many WadBrowsers as you like, each set up its own way.">On this machine</Heading>
          <div className="grid gap-2 sm:grid-cols-3">
            {apps.map((e) => (
              <AppCard
                key={e.id}
                entry={e}
                on={picked.includes(e.id)}
                onToggle={() => toggle(e.id)}
                onCustomize={
                  e.item.kind === "browser" && !e.once
                    ? () =>
                        e.item.kind === "browser" &&
                        setCustomizing({
                          kind: "browser",
                          base: e.item.config,
                          savedId: e.item.savedId,
                        })
                    : undefined
                }
                onRemove={
                  e.once
                    ? () => setOnce((o) => o.filter((x) => x.id !== e.id))
                    : e.item.kind === "browser" && e.item.savedId
                      ? () => {
                          const id = e.item.kind === "browser" ? e.item.savedId : undefined;
                          if (id && confirm(`Delete the saved setup ${e.label}?`)) {
                            void remove("browser", id);
                            setPicked((p) => p.filter((x) => x !== e.id));
                          }
                        }
                      : undefined
                }
              />
            ))}
          </div>
        </section>
      </div>

      <div className="flex items-center gap-2 border-t border-line pt-4">
        <span className="mr-auto text-xs text-muted">{picked.length ? `${picked.length} picked` : "Pick one or more"}</span>
        <Button variant="secondary" disabled={!picked.length || going} onClick={() => setFocus(true)}>
          <Lock className="size-4" /> Focus mode…
        </Button>
        <Button variant="primary" disabled={!picked.length || going} onClick={() => void go(null)}>
          <Play className="size-4 fill-current" /> Launch
        </Button>
      </div>
    </div>
  );
}

/** A saved setup as the launcher runs it. */
const configOf = (b: BrowserSetup): BrowserConfig => ({
  id: b.id,
  name: b.name,
  mode: b.mode,
  webapps: b.webapps,
  secrets: b.secrets,
});

function Check2({ on }: { on: boolean }) {
  return <span className={clsx("grid size-5 shrink-0 place-items-center rounded-full", on ? "bg-accent text-accent-fg" : "ring-1 ring-line-strong")}>{on && <Check className="size-3" />}</span>;
}

function SpaceCard({ entry, w, on, onToggle, onCustomize, onRemove }: { entry: Entry; w: WadspaceV2; on: boolean; onToggle: () => void; onCustomize?: () => void; onRemove?: () => void }) {
  const templates = useApp((s) => s.templates);
  const customizations = useApp((s) => s.customizations);
  const projects = useApp((s) => s.projects);
  const state = useImageState(imageKey(w.base));
  const r = resolve({ templates, customizations }, w.base);
  const o = entry.item.kind === "wadspace" ? entry.item.overrides : undefined;
  const mounted = (o?.projects ?? w.projects).flatMap((id) => projects.find((p) => p.id === id) ?? []);
  const folders = `${mounted.length} folder${mounted.length === 1 ? "" : "s"}`;
  const note = w.legacyImage ? `${folders} · its image from before layers` : state === "built" ? folders : state === "building" ? `${folders} · its image is building` : `${folders} · its image builds first`;
  return (
    <div className={clsx("flex items-center gap-3 rounded-2xl p-2 ring-1 transition-all", on ? "bg-accent-soft ring-2 ring-accent" : "bg-surface-2 ring-line hover:ring-line-strong")}>
      <button type="button" disabled={!r} onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-3 text-left" aria-pressed={on}>
        <DesktopThumb items={r ? desktopFor(r.template, r.setup, mounted) : []} wallpaper={o?.wallpaper ?? w.wallpaper} zoom={2} className="aspect-video w-24 shrink-0 rounded-xl" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium">{entry.label}</span>
          <span className="block truncate text-[11px] text-muted">{r ? note : "Its template is gone"}</span>
          {entry.once && (
            <Badge tone="accent-2" className="mt-1">
              Throwaway run
            </Badge>
          )}
        </span>
        <Check2 on={on} />
      </button>
      {onCustomize && (
        <IconButton label={`Customize ${w.name}`} onClick={onCustomize} disabled={!r}>
          <SlidersHorizontal className="size-4" />
        </IconButton>
      )}
      {onRemove && (
        <IconButton label={`Remove ${entry.label}`} onClick={onRemove}>
          <X className="size-4" />
        </IconButton>
      )}
    </div>
  );
}

function AppCard({ entry, on, onToggle, onCustomize, onRemove }: { entry: Entry; on: boolean; onToggle: () => void; onCustomize?: () => void; onRemove?: () => void }) {
  const item = entry.item;
  const detail =
    item.kind === "browser"
      ? `${item.config.mode === "focus" ? "No address bar" : "Address bar"} · ${item.config.webapps.length ? item.config.webapps.map((w) => w.name).join(", ") : "no web apps"}`
      : "foot, on the machine";
  return (
    <div className={clsx("flex items-center gap-2 rounded-2xl p-2.5 ring-1 transition-all", on ? "bg-accent-soft ring-2 ring-accent" : "bg-surface-2 ring-line hover:ring-line-strong")}>
      <button type="button" onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-2.5 text-left" aria-pressed={on} aria-label={entry.label}>
        <img src={item.kind === "terminal" ? TERMINAL_ICON : BROWSER_ICON} alt="" className="size-8 shrink-0 object-contain" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium">{entry.label}</span>
          <span className="block truncate text-[11px] text-muted">{detail}</span>
          {entry.once ? (
            <Badge tone="accent-2" className="mt-1">
              Throwaway run
            </Badge>
          ) : item.kind === "browser" && item.savedId ? (
            <Badge className="mt-1">Saved</Badge>
          ) : null}
        </span>
        <Check2 on={on} />
      </button>
      {onCustomize && (
        <IconButton label={`Customize ${entry.label}`} onClick={onCustomize}>
          <SlidersHorizontal className="size-4" />
        </IconButton>
      )}
      {onRemove && (
        <IconButton label={`Remove ${entry.label}`} onClick={onRemove}>
          {entry.once ? <X className="size-4" /> : <Trash2 className="size-4" />}
        </IconButton>
      )}
    </div>
  );
}

// ------------------------------------------------------- customizing runs
function RunFooter({ problems, onCancel, children }: { problems: string[]; onCancel: () => void; children: React.ReactNode }) {
  return (
    <div className="space-y-2 border-t border-line pt-4">
      {problems.map((p) => (
        <p key={p} className="text-xs text-danger">
          {p}
        </p>
      ))}
      <div className="flex items-center gap-2">
        <Button variant="ghost" onClick={onCancel} className="mr-auto">
          Back
        </Button>
        {children}
      </div>
    </div>
  );
}

/** Runs `fn`, saying so if it fails; while it runs, `busy`. */
function useBusy() {
  const [busy, setBusy] = useState(false);
  const run = (what: string, fn: () => Promise<void>) => async () => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      useApp.getState().toast({
        title: `Couldn't ${what}`,
        body: (e as Error).message,
        tone: "error",
      });
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}

/** A wadspace's construction options for a run: name, background, folders and secrets. Save it as a new wadspace, or run it once. */
export function WadspaceRun({ w, onCancel, onRun, onSaved }: { w: WadspaceV2; onCancel: () => void; onRun: (o: RunOverrides) => void; onSaved: (w: WadspaceV2) => void }) {
  const templates = useApp((s) => s.templates);
  const customizations = useApp((s) => s.customizations);
  const wadspaces = useApp((s) => s.wadspaces);
  useApp((s) => s.signIns);
  const saveWadspace = useApp((s) => s.saveWadspace);
  const { busy, run } = useBusy();
  const [d, setD] = useState<WadspaceDraft>(() => ({
    ...fromSaved(w),
    id: undefined,
    name: "",
  }));
  const r = resolve({ templates, customizations }, w.base);
  const slots = r ? slotsFor(r.template, r.setup) : [];
  // New secrets are named after the run's name, else the wadspace's.
  const forSlots = { name: d.name.trim() || w.name, secrets: d.secrets };
  const resolved = resolveSlots(forSlots, slots, useApp.getState().knownSignIns());
  const { problems } = resolved;
  const taken = !!d.name.trim() && named(d.name, wadspaces);
  const set = (patch: Partial<WadspaceDraft>) => setD((x) => ({ ...x, ...patch }));

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <SlidersHorizontal className="size-5 text-accent" />
        <div>
          <div className="text-sm font-semibold">Customize {w.name}</div>
          <div className="text-xs text-muted">Its construction options for this run. Its apps and image stay as they are.</div>
        </div>
      </div>
      <div className="max-h-[56vh] space-y-6 overflow-y-auto pr-1">
        <section className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label>Name</Label>
            <Input value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder="Needed to save it as a new wadspace" aria-label="New wadspace name" />
            {taken && <p className="mt-1 text-xs text-danger">There&apos;s a wadspace called that already.</p>}
          </div>
          <div>
            <Label>Description</Label>
            <Textarea value={d.description} onChange={(e) => set({ description: e.target.value })} rows={1} />
          </div>
        </section>
        <section className="max-w-xl">
          <Heading>Background</Heading>
          <WallpaperPicker value={d.wallpaper} onChange={(wallpaper) => set({ wallpaper })} />
        </section>
        <section>
          <Heading
            hint={
              r && !opensFolders(r.template)
                ? `Mounted at ~/Desktop/<folder>. Nothing in ${r.template.name} opens a folder in a window, so they get no desktop icon.`
                : "Mounted at ~/Desktop/<folder>, each a folder on the desktop."
            }
          >
            Folders
          </Heading>
          <ProjectsPanel value={d.projects} onChange={(projects) => set({ projects })} />
        </section>
        <section>
          <Heading hint="New and saved ones are kept on the machine. Don't save: sign in inside the app, and nothing is kept.">Secrets</Heading>
          {slots.length ? (
            <SecretSlots
              slots={slots}
              draft={forSlots}
              dontSave="Sign in inside the app; nothing is saved on the machine (a throwaway run forgets it when it closes)."
              onSlot={(key: string, c: SlotChoice) => set({ secrets: { ...d.secrets, [key]: c } })}
            />
          ) : (
            <p className="text-xs text-muted">Nothing in it keeps a sign-in.</p>
          )}
        </section>
      </div>
      <RunFooter problems={problems} onCancel={onCancel}>
        <Button
          variant="secondary"
          disabled={!!problems.length || busy}
          onClick={run("start the run", async () => {
            const secrets = await signInRefs(resolved);
            onRun({ wallpaper: d.wallpaper, projects: d.projects, secrets });
          })}
        >
          <Play className="size-4" /> Throwaway run
        </Button>
        <Button
          variant="primary"
          disabled={!d.name.trim() || taken || !!problems.length || busy}
          title={!d.name.trim() ? "Name it to save it" : undefined}
          onClick={run("save it", async () => {
            const secrets = await signInRefs(resolved);
            onSaved(
              await saveWadspace({
                name: d.name.trim(),
                description: d.description.trim(),
                base: w.base,
                wallpaper: d.wallpaper,
                projects: d.projects,
                secrets,
              }),
            );
          })}
        >
          <Plus className="size-4" /> Save as new wadspace
        </Button>
      </RunFooter>
    </div>
  );
}

/** A WadBrowser run: with an address bar or Focus, web apps to open, and their sign-ins (shared or their own). Save the setup to launch later, or run it once. */
function BrowserRun({ base, savedId, onCancel, onRun, onSaved }: { base: BrowserConfig; savedId?: string; onCancel: () => void; onRun: (c: BrowserConfig) => void; onSaved: (c: BrowserSetup) => void }) {
  const browsers = useApp((s) => s.browsers);
  const customizations = useApp((s) => s.customizations);
  useApp((s) => s.signIns);
  const saveBrowser = useApp((s) => s.saveBrowser);
  const { busy, run } = useBusy();
  const [name, setName] = useState(savedId ? base.name : "");
  const [mode, setMode] = useState(base.mode);
  const [webapps, setWebapps] = useState<WebApp[]>(base.webapps);
  const [choices, setChoices] = useState<Record<string, SlotChoice>>(() => asChoices(base.secrets));
  const [appName, setAppName] = useState("");
  const [appUrl, setAppUrl] = useState("");
  const slots = browserSlots({ webapps });
  // New sign-ins are named after the setup (<name>-WadBrowser-<app>); an unnamed one's are WadSpaces-WadBrowser.<app>.
  const setupName = name.trim() || (savedId ? base.name : "");
  const forSlots = {
    name: setupName,
    secrets: choices,
    ...(!setupName && {
      defaultName: (slot: { appId: string }) => `WadSpaces-WadBrowser.${slot.appId.replace(/^WadBrowser-/, "")}`,
    }),
  };
  const resolved = resolveSlots(forSlots, slots, useApp.getState().knownSignIns());
  const { problems } = resolved;
  const takenBy = [...browsers, ...DEFAULT_BROWSERS];
  const taken = (n: string, except?: string) => !!n.trim() && named(n, takenBy, except);
  const known = knownWebapps(alive(customizations), alive(browsers)).filter((w) => !webapps.some((x) => x.url === w.url));
  const config = (id: string, n: string, secrets: Record<string, SignInRef>): BrowserConfig => ({ id, name: n, mode, webapps, secrets });

  const add = (w: Omit<WebApp, "id">) => {
    let id = webappId(w.name);
    for (let i = 2; webapps.some((x) => x.id === id); i++) id = `${webappId(w.name)}-${i}`;
    setWebapps((list) => [...list, { ...w, id }]);
  };
  const addTyped = () => {
    let url = appUrl.trim();
    if (!appName.trim() || !url) return;
    if (!/^https?:\/\//.test(url)) url = `https://${url}`;
    add({ name: appName.trim(), url });
    setAppName("");
    setAppUrl("");
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <img src={BROWSER_ICON} alt="" className="size-7" />
        <div>
          <div className="text-sm font-semibold">Customize {base.name}</div>
          <div className="text-xs text-muted">Runs on the machine, beside the spaces. Run several at once, each set up its own way.</div>
        </div>
      </div>
      <div className="max-h-[56vh] space-y-6 overflow-y-auto pr-1">
        <section className="grid gap-2 sm:grid-cols-2">
          <Choice on={mode === "browser"} onClick={() => setMode("browser")} title="WadBrowser" body="Tabs and an address bar" />
          <Choice on={mode === "focus"} onClick={() => setMode("focus")} title="WadBrowser Focus" body="No address bar: pages only arrive by links" />
        </section>
        <section>
          <Heading hint="Each opens in its own window.">Web apps</Heading>
          <div className="space-y-1">
            {webapps.map((w) => (
              <div key={w.id} className="flex items-center gap-2.5 rounded-xl bg-surface-2 px-2.5 py-1.5 ring-1 ring-line">
                <img src={webappIcon(w.url)} alt="" className="size-4 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{w.name}</span>
                  <span className="block truncate text-[11px] text-muted">{w.url}</span>
                </span>
                <IconButton label={`Remove ${w.name}`} onClick={() => setWebapps((list) => list.filter((x) => x.id !== w.id))}>
                  <Trash2 className="size-3.5" />
                </IconButton>
              </div>
            ))}
          </div>
          {known.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {known.map((w) => (
                <button
                  key={w.url}
                  type="button"
                  onClick={() => add({ name: w.name, url: w.url })}
                  className="flex items-center gap-1.5 rounded-lg bg-surface-2 px-2 py-1 text-xs ring-1 ring-line hover:ring-line-strong"
                  aria-label={`Add ${w.name}`}
                >
                  <img src={webappIcon(w.url)} alt="" className="size-3.5" /> {w.name} <Plus className="size-3 text-faint" />
                </button>
              ))}
            </div>
          )}
          <form
            className="mt-2 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              addTyped();
            }}
          >
            <Input value={appName} onChange={(e) => setAppName(e.target.value)} placeholder="Name" className="h-9 !w-36 text-[13px]" aria-label="Web app name" />
            <Input value={appUrl} onChange={(e) => setAppUrl(e.target.value)} placeholder="https://…" className="h-9 flex-1 text-[13px]" aria-label="Web app address" />
            <Button size="sm" type="submit" className="h-9" disabled={!appName.trim() || !appUrl.trim()}>
              <Plus className="size-3.5" /> Add
            </Button>
          </form>
        </section>
        {slots.length > 0 && (
          <section>
            <Heading hint="Pick the same secret for several to share one cookie profile. Don't save: sign in in the window, and nothing is kept.">Sign-ins</Heading>
            <SecretSlots
              slots={slots}
              draft={forSlots}
              dontSave="Signs in in its window; nothing is saved on the machine, and it's forgotten when WadBrowser closes."
              onSlot={(key: string, c: SlotChoice) => setChoices((x) => ({ ...x, [key]: c }))}
            />
          </section>
        )}
        <section>
          <Label>Name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Needed to save this setup" aria-label="Setup name" />
          {taken(name, savedId) && <p className="mt-1 text-xs text-danger">There&apos;s a setup called that already.</p>}
        </section>
      </div>
      <RunFooter problems={problems} onCancel={onCancel}>
        <Button
          variant="secondary"
          disabled={!!problems.length || busy}
          onClick={run("start the run", async () => {
            const secrets = await signInRefs(resolved);
            onRun(config(`run-${Date.now().toString(36)}`, name.trim() || (mode === "focus" ? "WadBrowser Focus" : "WadBrowser"), secrets));
          })}
        >
          <Play className="size-4" /> Throwaway run
        </Button>
        {savedId && (
          <Button
            variant="secondary"
            disabled={!name.trim() || taken(name, savedId) || !!problems.length || busy}
            onClick={run("update it", async () => {
              const secrets = await signInRefs(resolved);
              onSaved(await saveBrowser(config(savedId, name.trim(), secrets)));
            })}
          >
            Update
          </Button>
        )}
        <Button
          variant="primary"
          disabled={!name.trim() || taken(name) || !!problems.length || busy}
          title={!name.trim() ? "Name it to save it" : undefined}
          onClick={run("save it", async () => {
            const secrets = await signInRefs(resolved);
            const { id: _id, ...rest } = config("", name.trim(), secrets);
            onSaved(await saveBrowser(rest));
          })}
        >
          <Plus className="size-4" /> {savedId ? "Save as new setup" : "Save setup"}
        </Button>
      </RunFooter>
    </div>
  );
}
