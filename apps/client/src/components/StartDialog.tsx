import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, Check, CircleAlert, Folder, FolderGit2, HardDrive, Loader2, Lock, Play, Plus, RotateCw, Timer, X } from "lucide-react";
import clsx from "clsx";
import { backend } from "@/data";
import type { Project, ProjectStatus } from "@core/projects";
import { clockTime } from "@/lib/format";
import { startWadspaces, type LaunchJob } from "@/lib/launch";
import { THIS_MACHINE, useApp } from "@/lib/store";
import { useUi } from "@/lib/ui";
import type { Wadspace } from "@/lib/types";
import { AddFromGithub } from "./GithubRepos";
import { AddDriveDialog, AddFolderDialog } from "./HostFolders";
import { SourceIcon } from "./ProjectDialog";
import { Thumb } from "./Thumb";
import { Button, Input, Label, Modal, Progress } from "./ui";

type Step = "pick" | "time" | "projects" | "starting";

const STEPS: { step: Step; label: string }[] = [
  { step: "pick", label: "Wadspaces" },
  { step: "time", label: "Time" },
  { step: "projects", label: "Projects" },
];

const PRESETS = [25, 50, 90, 120];

const fmtMinutes = (m: number) => (m < 60 ? `${m} min` : m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} h`);

/**
 * Start: pick wadspaces on this machine, how long and whether it's a focus
 * session, and the projects each opens with. They all launch together and
 * the first one ready takes the screen.
 */
export function StartDialog() {
  const start = useUi((s) => s.start);
  const closeStart = useUi((s) => s.closeStart);
  return (
    <Modal open={!!start} onClose={closeStart} width={720} title="Start" subtitle="Open wadspaces on this machine, with your projects on their Desktops.">
      {start && <Flow preselect={start.preselect} focus={start.focus} onClose={closeStart} />}
    </Modal>
  );
}

function Flow({ preselect, focus: focusFirst, onClose }: { preselect: string[]; focus: boolean; onClose: () => void }) {
  const wadspaces = useApp((s) => s.wadspaces);
  const machines = useApp((s) => s.machines);
  const projects = useApp((s) => s.projects);
  const focusOn = useApp((s) => !!s.focus);
  const [step, setStep] = useState<Step>("pick");
  const [picked, setPicked] = useState<string[]>(() => preselect.filter((id) => wadspaces.some((w) => w.id === id && w.installed)));
  const [minutes, setMinutes] = useState(50);
  const [focus, setFocus] = useState(focusFirst);
  /** Each pick's projects, once the projects step has seen it. */
  const [assigned, setAssigned] = useState<Record<string, string[]>>({});
  const [status, setStatus] = useState<Record<string, ProjectStatus | null>>({});
  const [launchIds, setLaunchIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const withProjects = backend.caps.projects;

  const here = machines.find((m) => m.id === THIS_MACHINE);
  const running = (id: string) => !!here?.containers.some((c) => c.wadspaceId === id && c.status === "running");
  // What this machine can open (installed), the running ones first.
  const list = useMemo(
    () => [...wadspaces].sort((a, b) => Number(!!b.installed) - Number(!!a.installed) || Number(running(b.id)) - Number(running(a.id)) || a.name.localeCompare(b.name)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [wadspaces, here],
  );
  const picks = picked.map((id) => wadspaces.find((w) => w.id === id)).filter((w): w is Wadspace => !!w);

  // Each project's folder here: one on another machine, or a drive that isn't plugged in, can't open.
  useEffect(() => {
    if (!withProjects) return;
    let off = false;
    Promise.all(projects.map(async (p) => [p.id, await backend.projectStatus(p.id).catch(() => null)] as const)).then((rows) => !off && setStatus(Object.fromEntries(rows)));
    return () => {
      off = true;
    };
  }, [projects, withProjects]);

  const available = (id: string) => status[id]?.available !== false && projects.some((p) => p.id === id);
  /** What it has mounted now, or its defaults when it has none yet. */
  const current = (ws: Wadspace) => (ws.mountedProjects ?? ws.advanced.projects ?? []).filter(available);
  const projectsOf = (ws: Wadspace) => assigned[ws.id] ?? current(ws);
  const setProjects = (ws: Wadspace, ids: string[]) => setAssigned((a) => ({ ...a, [ws.id]: ids }));

  const clashIn = (ws: Wadspace) => {
    const chosen = projects.filter((p) => projectsOf(ws).includes(p.id));
    return chosen.find((p, i) => chosen.findIndex((q) => q.mountName === p.mountName) !== i);
  };
  const anyClash = picks.some((w) => clashIn(w));

  const go = async () => {
    setBusy(true);
    setStep("starting");
    const ids = await startWadspaces(
      picks.map((ws) => ({ ws, projectIds: withProjects ? projectsOf(ws).filter(available) : [] })),
      focus ? minutes : null,
      onClose,
    );
    setBusy(false);
    if (!ids) setStep("projects");
    else setLaunchIds(ids);
  };

  const next = () => setStep(step === "pick" ? "time" : "projects");
  const back = () => setStep(step === "projects" ? "time" : "pick");
  const lastStep = step === "projects" || (step === "time" && !withProjects);

  if (focusOn && step !== "starting") {
    return (
      <div className="space-y-4">
        <p className="flex items-start gap-3 rounded-2xl bg-accent-soft p-4 text-sm ring-1 ring-accent/20">
          <Lock className="mt-0.5 size-4 shrink-0 text-accent" /> A focus session is on. Start something new when its time is up.
        </p>
        <div className="flex justify-end">
          <Button onClick={onClose}>Close</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {step !== "starting" && <Steps step={step} withProjects={withProjects} />}

      {step === "pick" && (
        <div>
          <Label hint={`${picked.length} selected`}>Which wadspaces?</Label>
          {list.length ? (
            <div className="grid max-h-[360px] grid-cols-1 gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
              {list.map((w) => {
                const on = picked.includes(w.id);
                return (
                  <button
                    key={w.id}
                    type="button"
                    disabled={!w.installed}
                    title={w.installed ? undefined : "Not on this machine yet: build it in the Builder first"}
                    onClick={() => setPicked(on ? picked.filter((x) => x !== w.id) : [...picked, w.id])}
                    className={clsx(
                      "flex items-center gap-2.5 rounded-2xl p-1.5 pr-3 text-left ring-1 transition-all disabled:cursor-not-allowed disabled:opacity-45",
                      on ? "bg-accent-soft ring-2 ring-accent" : "bg-surface-2 ring-line hover:ring-line-strong",
                    )}
                  >
                    <Thumb ws={w} className="!w-20 shrink-0 rounded-xl" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium">{w.name}</span>
                      <span className="block truncate text-[11px] text-muted">{!w.installed ? "Build it first" : running(w.id) ? "Running" : "On this machine"}</span>
                    </span>
                    <span className={clsx("grid size-5 shrink-0 place-items-center rounded-full", on ? "bg-accent text-accent-fg" : "ring-1 ring-line-strong")}>{on && <Check className="size-3" />}</span>
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="rounded-2xl bg-surface-2 px-4 py-3 text-sm text-muted ring-1 ring-line">No wadspaces yet. Make one in the Builder.</p>
          )}
        </div>
      )}

      {step === "time" && <TimeStep minutes={minutes} setMinutes={setMinutes} focus={focus} setFocus={setFocus} />}

      {step === "projects" && (
        <div className="space-y-2.5">
          <Label>The projects on each one&apos;s Desktop</Label>
          {picks.map((ws) => (
            <ProjectsRow
              key={ws.id}
              ws={ws}
              ids={projectsOf(ws)}
              onChange={(ids) => setProjects(ws, ids)}
              status={status}
              restarts={running(ws.id) && !sameSet(projectsOf(ws), ws.mountedProjects ?? [])}
              clash={clashIn(ws)}
            />
          ))}
        </div>
      )}

      {step === "starting" && <Starting picks={picks} launchIds={launchIds} busy={busy} focus={focus ? minutes : null} onClose={onClose} />}

      {step !== "starting" && (
        <div className="flex items-center gap-2 border-t border-line pt-4">
          {step !== "pick" && (
            <Button variant="ghost" onClick={back} className="mr-auto">
              <ArrowLeft className="size-4" /> Back
            </Button>
          )}
          <Button variant="ghost" onClick={onClose} className={clsx(step === "pick" && "ml-auto")}>
            Cancel
          </Button>
          {lastStep ? (
            <Button variant="primary" onClick={go} disabled={!picks.length || anyClash}>
              {focus ? <Timer className="size-4" /> : <Play className="size-4 fill-current" />} {focus ? `Start and focus for ${fmtMinutes(minutes)}` : "Start"}
            </Button>
          ) : (
            <Button variant="primary" onClick={next} disabled={!picks.length}>
              Next <ArrowRight className="size-4" />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function Steps({ step, withProjects }: { step: Step; withProjects: boolean }) {
  const steps = withProjects ? STEPS : STEPS.slice(0, 2);
  const at = steps.findIndex((s) => s.step === step);
  return (
    <ol className="flex items-center gap-2 text-xs font-medium">
      {steps.map((s, i) => (
        <li key={s.step} className="flex items-center gap-2">
          {i > 0 && <span className="h-px w-6 bg-line-strong" />}
          <span className={clsx("grid size-5 place-items-center rounded-full text-[10.5px]", i < at ? "bg-accent text-accent-fg" : i === at ? "bg-accent-soft text-accent ring-1 ring-accent" : "bg-surface-2 text-faint ring-1 ring-line")}>
            {i < at ? <Check className="size-3" /> : i + 1}
          </span>
          <span className={i === at ? "text-fg" : "text-muted"}>{s.label}</span>
        </li>
      ))}
    </ol>
  );
}

function TimeStep({ minutes, setMinutes, focus, setFocus }: { minutes: number; setMinutes: (m: number) => void; focus: boolean; setFocus: (f: boolean) => void }) {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  const set = (h: number, m: number) => setMinutes(Math.min(12 * 60, Math.max(1, h * 60 + m)));
  return (
    <div className="space-y-5">
      <div>
        <Label hint={`until about ${clockTime(Date.now() + minutes * 60_000)}`}>How long?</Label>
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

      <div>
        <Label>Enter these wadspaces in a focus session?</Label>
        <div className="grid gap-2 sm:grid-cols-2">
          <Choice on={focus} onClick={() => setFocus(true)} icon={<Lock className="size-4" />} title="Yes, focus" body={`Only these open for ${fmtMinutes(minutes)}, from when the first is on screen. There's no ending it early.`} />
          <Choice on={!focus} onClick={() => setFocus(false)} icon={<Play className="size-4" />} title="No, just open them" body="No timer: they're a Super+Tab away from each other, and you can leave them any time." />
        </div>
      </div>
    </div>
  );
}

function Choice({ on, onClick, icon, title, body }: { on: boolean; onClick: () => void; icon: React.ReactNode; title: string; body: string }) {
  return (
    <button type="button" onClick={onClick} className={clsx("flex gap-3 rounded-2xl p-3.5 text-left ring-1 transition-all", on ? "bg-accent-soft ring-2 ring-accent" : "bg-surface-2 ring-line hover:ring-line-strong")}>
      <span className={clsx("grid size-8 shrink-0 place-items-center rounded-xl", on ? "bg-accent text-accent-fg" : "bg-surface-3 text-muted")}>{icon}</span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold">{title}</span>
        <span className="mt-0.5 block text-xs text-muted">{body}</span>
      </span>
    </button>
  );
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** One pick's projects: the ones it opens with, and changing them. */
function ProjectsRow({
  ws,
  ids,
  onChange,
  status,
  restarts,
  clash,
}: {
  ws: Wadspace;
  ids: string[];
  onChange: (ids: string[]) => void;
  status: Record<string, ProjectStatus | null>;
  restarts: boolean;
  clash?: Project;
}) {
  const projects = useApp((s) => s.projects);
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState<"github" | "folder" | "drive" | null>(null);
  const chosen = ids.map((id) => projects.find((p) => p.id === id)).filter((p): p is Project => !!p);
  const toggle = (id: string) => onChange(ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);
  const added = (p: Project) => {
    if (!ids.includes(p.id)) onChange([...ids, p.id]);
    setAdding(null);
  };

  return (
    <div className="rounded-2xl bg-surface-2/60 p-3 ring-1 ring-line">
      <div className="flex items-start gap-3">
        <Thumb ws={ws} className="!w-24 shrink-0 rounded-xl" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-semibold">{ws.name}</span>
            <Button size="sm" variant={open ? "secondary" : "ghost"} onClick={() => setOpen(!open)}>
              {open ? "Done" : chosen.length ? "Change" : <><Plus className="size-3.5" /> Add projects</>}
            </Button>
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {chosen.length ? (
              chosen.map((p) => (
                <span key={p.id} className="inline-flex items-center gap-1.5 rounded-lg bg-surface py-1 pl-2 pr-1 text-xs ring-1 ring-line">
                  <SourceIcon project={p} className="size-3.5 text-muted" />
                  <span className="max-w-[160px] truncate">{p.name}</span>
                  <button type="button" onClick={() => toggle(p.id)} className="grid size-4 place-items-center rounded text-faint hover:bg-surface-3 hover:text-fg" aria-label={`Remove ${p.name}`}>
                    <X className="size-3" />
                  </button>
                </span>
              ))
            ) : (
              <span className="text-xs text-faint">No projects: an empty Desktop.</span>
            )}
          </div>
          {restarts && (
            <p className="mt-2 flex items-center gap-1.5 text-xs text-accent-2">
              <RotateCw className="size-3.5 shrink-0" /> It&apos;s running with other projects: it restarts. Anything unsaved in its apps is lost.
            </p>
          )}
          {clash && <p className="mt-2 text-xs text-danger">Two of these open as ~/Desktop/{clash.mountName}. Keep one.</p>}
        </div>
      </div>

      {open && (
        <div className="mt-3 space-y-1.5 border-t border-line pt-3">
          {projects.length ? (
            <div className="max-h-56 space-y-1 overflow-y-auto pr-1">
              {projects.map((p) => {
                const off = status[p.id]?.available === false;
                const on = ids.includes(p.id) && !off;
                return (
                  <label
                    key={p.id}
                    className={clsx(
                      "flex items-center gap-3 rounded-xl px-3 py-2 ring-1 transition-colors",
                      off ? "cursor-not-allowed opacity-55 ring-line" : on ? "cursor-pointer bg-accent-soft ring-accent" : "cursor-pointer bg-surface ring-line hover:ring-line-strong",
                    )}
                  >
                    <input type="checkbox" checked={on} disabled={off} onChange={() => toggle(p.id)} className="size-4 accent-[var(--accent)]" />
                    <SourceIcon project={p} className="size-4 shrink-0 text-muted" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{p.name}</span>
                      <span className="block truncate font-mono text-[11px] text-muted">{off ? `Can't open here: ${status[p.id]?.reason ?? "not on this machine"}` : `~/Desktop/${p.mountName}`}</span>
                    </span>
                    {ws.advanced.projects?.includes(p.id) && <span className="text-[11px] text-faint">default</span>}
                  </label>
                );
              })}
            </div>
          ) : (
            <p className="text-xs text-muted">You have no projects yet. Add one:</p>
          )}
          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            <span className="mr-1 text-xs text-muted">New project:</span>
            <Button size="sm" onClick={() => setAdding("github")}>
              <FolderGit2 className="size-3.5" /> From GitHub
            </Button>
            <Button size="sm" onClick={() => setAdding("folder")}>
              <Folder className="size-3.5" /> Folder
            </Button>
            <Button size="sm" onClick={() => setAdding("drive")}>
              <HardDrive className="size-3.5" /> Drive
            </Button>
          </div>
        </div>
      )}

      <AddFromGithub open={adding === "github"} onClose={() => setAdding(null)} onAdded={added} />
      <AddFolderDialog open={adding === "folder"} onClose={() => setAdding(null)} onAdded={added} />
      <AddDriveDialog open={adding === "drive"} onClose={() => setAdding(null)} onAdded={added} />
    </div>
  );
}

/** Launching: each pick getting ready; the first one ready takes the screen (and this closes). */
function Starting({ picks, launchIds, busy, focus, onClose }: { picks: Wadspace[]; launchIds: string[]; busy: boolean; focus: number | null; onClose: () => void }) {
  const launches = useApp((s) => s.launches);
  const jobs = launchIds.map((id) => launches.find((l) => l.id === id)).filter((l): l is LaunchJob => !!l);
  const allFailed = !busy && jobs.length > 0 && jobs.every((l) => l.status === "error" || l.status === "cancelled");
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        {allFailed
          ? "None of them started. The sidebar has each one's log."
          : `Getting ${picks.length === 1 ? picks[0].name : `${picks.length} wadspaces`} ready${focus ? ` for a ${fmtMinutes(focus)} focus session` : ""}. You'll be taken to the first one that's ready; the rest keep going in the background.`}
      </p>
      <div className="divide-y divide-line overflow-hidden rounded-2xl ring-1 ring-line">
        {picks.map((ws) => {
          const job = jobs.find((l) => l.wadspaceId === ws.id);
          return (
            <div key={ws.id} className="flex items-center gap-3 bg-surface-2/50 px-3.5 py-3">
              <Thumb ws={ws} className="!w-16 shrink-0 rounded-lg" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{ws.name}</div>
                <div className={clsx("truncate text-xs", job?.status === "error" ? "text-danger" : "text-muted")}>
                  {!job ? (busy ? "Waiting to start" : "Didn't start") : job.status === "done" ? "Ready" : job.status === "error" ? (job.error ?? "Didn't start") : job.status === "cancelled" ? "Cancelled" : job.phase}
                </div>
                {job && (job.status === "queued" || job.status === "running") && <Progress value={job.progress} className="mt-1.5 !h-1" />}
              </div>
              {!job && busy ? (
                <Loader2 className="size-4 animate-spin text-faint" />
              ) : job?.status === "done" ? (
                <Check className="size-4 text-accent" />
              ) : job?.status === "error" || job?.status === "cancelled" || !job ? (
                <CircleAlert className="size-4 text-danger" />
              ) : (
                <Loader2 className="size-4 animate-spin text-accent" />
              )}
            </div>
          );
        })}
      </div>
      <div className="flex justify-end">
        <Button onClick={onClose}>{allFailed ? "Close" : "Hide"}</Button>
      </div>
    </div>
  );
}
