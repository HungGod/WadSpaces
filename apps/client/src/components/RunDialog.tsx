import { Link } from "react-router";
import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { Check, CircleAlert, Folder, HardDrive, Loader2, MonitorPlay, Play, Radio, RotateCw } from "lucide-react";
import clsx from "clsx";
import { backend } from "@/data";
import type { LaunchPart } from "@/data/backend";
import type { ProjectStatus } from "@core/projects";
import { RestartNeeded, cancelLaunch, launchWadspace, type LaunchJob } from "@/lib/launch";
import { useApp } from "@/lib/store";
import { useUi } from "@/lib/ui";
import type { Wadspace } from "@/lib/types";
import { SourceIcon } from "./ProjectDialog";
import { Button, Modal, Progress } from "./ui";

/**
 * Open a wadspace with projects: pick them (its defaults ticked), then follow
 * the launch, the image and each project's folder getting ready, then the
 * start. Offline only for now; trusted machines bring it online.
 */
export function RunDialog() {
  const run = useUi((s) => s.run);
  const closeRun = useUi((s) => s.closeRun);
  const ws = useApp((s) => s.wadspaces.find((w) => w.id === run?.wadspaceId));
  const job = useApp((s) => s.launches.find((l) => l.id === run?.launchId));
  const title = job ? jobTitle(job) : ws ? `Open ${ws.name}` : undefined;

  // The launch it followed was dismissed (a finished one clears itself): nothing left to show.
  useEffect(() => {
    if (run?.launchId && !job) closeRun();
  }, [run?.launchId, job, closeRun]);

  return (
    <Modal open={!!run && !!ws} onClose={closeRun} width={560} title={title} subtitle={job ? jobSubtitle(job) : "Pick the projects to open on its Desktop."}>
      {ws && (backend.target === "online" ? <OnlineSoon onClose={closeRun} /> : job ? <Following job={job} ws={ws} /> : <Picker key={ws.id} ws={ws} />)}
    </Modal>
  );
}

function OnlineSoon({ onClose }: { onClose: () => void }) {
  return (
    <div className="space-y-4">
      <p className="rounded-2xl bg-surface-2 px-4 py-3 text-sm text-muted ring-1 ring-line">
        Launching on a machine from the web, with your projects, arrives with trusted machines. For now, open it in WadSpaces on that machine.
      </p>
      <div className="flex justify-end">
        <Button onClick={onClose}>Close</Button>
      </div>
    </div>
  );
}

function Picker({ ws }: { ws: Wadspace }) {
  const projects = useApp((s) => s.projects);
  const openRun = useUi((s) => s.openRun);
  const toast = useApp((s) => s.toast);
  // Its defaults, or what it ran with last when it has none.
  const [picked, setPicked] = useState<string[]>(() =>
    (ws.advanced.projects?.length ? ws.advanced.projects : (ws.mountedProjects ?? [])).filter((id) => projects.some((p) => p.id === id)),
  );
  const [restart, setRestart] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  /** Each project here: a folder on another machine, or a drive that isn't plugged in, can't open. */
  const [status, setStatus] = useState<Record<string, ProjectStatus | null>>({});

  useEffect(() => {
    let off = false;
    Promise.all(projects.map(async (p) => [p.id, await backend.projectStatus(p.id).catch(() => null)] as const)).then((rows) => {
      if (off) return;
      const st = Object.fromEntries(rows);
      setStatus(st);
      // A default that can't open here isn't ticked.
      setPicked((ids) => ids.filter((id) => st[id]?.available !== false));
    });
    return () => {
      off = true;
    };
  }, [projects]);

  const unavailable = (id: string) => status[id]?.available === false;
  const chosen = projects.filter((p) => picked.includes(p.id) && !unavailable(p.id));
  const clash = chosen.find((p, i) => chosen.findIndex((q) => q.mountName === p.mountName) !== i);
  const toggle = (id: string) => setPicked(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]);

  const go = async (withRestart = false) => {
    setStarting(true);
    try {
      // In the order the list shows them.
      const job = await launchWadspace(ws, chosen.map((p) => p.id), { restart: withRestart });
      openRun(ws.id, job.id);
    } catch (e) {
      if (e instanceof RestartNeeded) setRestart(e.message);
      else toast({ title: "Couldn't open", body: (e as Error).message, tone: "error" });
    } finally {
      setStarting(false);
    }
  };

  const view = ws.advanced.display === "host";
  return (
    <div className="space-y-4">
      <div className="max-h-72 space-y-1.5 overflow-y-auto">
        {projects.map((p) => {
          const off = unavailable(p.id);
          const on = picked.includes(p.id) && !off;
          return (
            <label
              key={p.id}
              className={clsx(
                "flex items-center gap-3 rounded-xl px-3 py-2.5 ring-1 transition-colors",
                off ? "cursor-not-allowed bg-surface-2 opacity-55 ring-line" : on ? "cursor-pointer bg-accent-soft ring-accent" : "cursor-pointer bg-surface-2 ring-line hover:ring-line-strong",
              )}
            >
              <input type="checkbox" checked={on} disabled={off} onChange={() => toggle(p.id)} className="size-4 accent-[var(--accent)]" />
              <span className="shrink-0 text-muted">
                <SourceIcon project={p} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{p.name}</span>
                <span className="block truncate font-mono text-[11px] text-muted">
                  {off ? `Can't open here: ${status[p.id]?.reason ?? "not on this machine"}` : `~/Desktop/${p.mountName}`}
                </span>
              </span>
              {ws.advanced.projects?.includes(p.id) && <span className="text-[11px] text-faint">default</span>}
            </label>
          );
        })}
      </div>
      {clash && <p className="text-xs text-accent-2">Two of these open as ~/Desktop/{clash.mountName}. Pick one.</p>}

      <div className="flex items-center gap-2 rounded-xl bg-surface-2/60 px-3 py-2 text-xs text-muted ring-1 ring-line">
        {view ? <MonitorPlay className="size-4 shrink-0" /> : <Radio className="size-4 shrink-0" />}
        {view ? "On this machine's screen" : "Streamed into this machine's screen"}
      </div>

      {restart ? (
        <div className="space-y-3 rounded-2xl bg-accent-2-soft p-4 ring-1 ring-accent-2/45">
          <p className="text-sm">
            <b>{ws.name}</b> is running with other projects. Restart it with these? Anything unsaved in its apps is lost; files in projects stay.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setRestart(null)}>
              Not now
            </Button>
            <Button variant="primary" onClick={() => go(true)} disabled={starting}>
              {starting ? <Loader2 className="size-4 animate-spin" /> : <RotateCw className="size-4" />} Restart and open
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 pt-1">
          <Link to="/projects" onClick={() => useUi.getState().closeRun()} className="mr-auto text-sm font-medium text-muted hover:text-fg">
            Manage projects
          </Link>
          <Button variant="ghost" onClick={() => useUi.getState().closeRun()}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => go()} disabled={starting || !!clash}>
            {starting ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4 fill-current" />} Open{chosen.length ? ` with ${chosen.length} project${chosen.length > 1 ? "s" : ""}` : ""}
          </Button>
        </div>
      )}
    </div>
  );
}

/** A launch in progress (or just finished): each part, then the log. */
function Following({ job, ws }: { job: LaunchJob; ws: Wadspace }) {
  const closeRun = useUi((s) => s.closeRun);
  const openRun = useUi((s) => s.openRun);
  const removeLaunch = useApp((s) => s.removeLaunch);
  const toast = useApp((s) => s.toast);
  const log = useRef<HTMLDivElement>(null);
  const [showLog, setShowLog] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const active = job.status === "queued" || job.status === "running";
  // A running wadspace in the way (e.g. to move its old copy of a project out).
  const needsRestart = job.status === "error" && /pass restart/.test(job.error ?? "");

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [job.lines.length, showLog]);

  const retry = async (restart: boolean) => {
    setRetrying(true);
    try {
      const next = await launchWadspace(ws, job.projects, { restart });
      openRun(ws.id, next.id);
      removeLaunch(job.id);
    } catch (e) {
      toast({ title: "Couldn't open", body: (e as Error).message, tone: "error" });
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="divide-y divide-line overflow-hidden rounded-2xl ring-1 ring-line">
        {job.parts.map((p) => (
          <PartRow key={p.key} part={p} />
        ))}
        <div className="flex items-center gap-3 bg-surface-2/50 px-3.5 py-3">
          <StateIcon state={job.status === "done" ? "done" : job.status === "error" || job.status === "cancelled" ? "error" : job.phase === "starting" ? "working" : "waiting"} />
          <div className="min-w-0 flex-1 text-sm">
            Start {ws.name}
            <span className="block text-xs text-muted">{job.status === "done" ? "Running" : job.status === "cancelled" ? "Cancelled" : job.phase === "starting" ? (job.status === "error" ? "Didn't start" : "Starting") : "After the image and projects"}</span>
          </div>
        </div>
      </div>
      {active && <Progress value={job.progress} />}
      {job.error && !needsRestart && <p className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger ring-1 ring-danger/30">{job.error}</p>}
      {needsRestart && <p className="rounded-xl bg-accent-2-soft px-3 py-2 text-sm ring-1 ring-accent-2/45">{ws.name} has to restart for this. Anything unsaved in its apps is lost; files in projects stay.</p>}

      <button type="button" onClick={() => setShowLog(!showLog)} className="text-xs font-medium text-muted hover:text-fg">
        {showLog ? "Hide" : "Show"} the log ({job.lines.length} line{job.lines.length === 1 ? "" : "s"})
      </button>
      {showLog && (
        <div ref={log} className="h-48 overflow-y-auto rounded-2xl bg-[#07040f] p-4 font-mono text-[12px] leading-relaxed text-[#e9e3ff] ring-1 ring-white/10">
          {job.lines.map((l, i) => (
            <motion.div key={i} initial={{ opacity: 0 }} animate={{ opacity: 1 }} className={clsx("whitespace-pre-wrap break-words", l.startsWith("✓") && "text-[#c6ff1f]", l.startsWith("✗") && "text-[#ff6b9b]", /^(\s|»)/.test(l) && "text-white/60")}>
              {l}
            </motion.div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap justify-end gap-2">
        {active ? (
          <>
            <Button variant="ghost" onClick={() => cancelLaunch(job.id)}>
              Cancel
            </Button>
            <Button onClick={closeRun}>Hide</Button>
          </>
        ) : (
          <>
            <Button
              variant="ghost"
              onClick={() => {
                removeLaunch(job.id);
                closeRun();
              }}
            >
              Dismiss
            </Button>
            {job.status !== "done" &&
              (needsRestart ? (
                <Button variant="primary" onClick={() => retry(true)} disabled={retrying}>
                  <RotateCw className="size-4" /> Restart and open
                </Button>
              ) : (
                <Button variant="primary" onClick={() => retry(false)} disabled={retrying}>
                  <RotateCw className="size-4" /> Try again
                </Button>
              ))}
            {job.status === "done" && <Button onClick={closeRun}>Close</Button>}
          </>
        )}
      </div>
    </div>
  );
}

function PartRow({ part }: { part: LaunchPart }) {
  return (
    <div className="flex items-center gap-3 bg-surface-2/50 px-3.5 py-3">
      <StateIcon state={part.state} kind={part.kind} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2 text-sm">
          <span className="truncate">{part.kind === "image" ? "The image" : part.name}</span>
          {part.state === "working" && part.progress != null && <span className="shrink-0 text-xs tabular-nums text-faint">{Math.floor(part.progress * 100)}%</span>}
        </div>
        {/* A project's says how its folder got ready ("updated (3 new commits)", "uncommitted changes — left as is", open on another machine…): all of it. */}
        <div className={clsx("text-xs", part.kind === "image" ? "truncate" : "whitespace-pre-line break-words", part.state === "error" ? "text-danger" : "text-muted")} title={part.message ?? undefined}>
          {part.message ?? (part.kind === "image" ? part.name : "waiting")}
        </div>
        {part.state === "working" && part.progress != null && <Progress value={part.progress} className="mt-1.5 !h-1" />}
      </div>
    </div>
  );
}

function StateIcon({ state, kind }: { state: LaunchPart["state"]; kind?: LaunchPart["kind"] }) {
  const base = "grid size-8 shrink-0 place-items-center rounded-xl";
  if (state === "done") return <span className={clsx(base, "bg-accent-soft text-fg dark:text-accent")}><Check className="size-4" strokeWidth={3} /></span>;
  if (state === "error") return <span className={clsx(base, "bg-danger/10 text-danger")}><CircleAlert className="size-4" /></span>;
  if (state === "working") return <span className={clsx(base, "bg-surface-3 text-accent")}><Loader2 className="size-4 animate-spin" /></span>;
  return <span className={clsx(base, "bg-surface-3 text-faint")}>{kind === "project" ? <Folder className="size-4" /> : <HardDrive className="size-4" />}</span>;
}

function jobTitle(job: LaunchJob) {
  if (job.status === "done") return `${job.name} is open`;
  if (job.status === "error") return `${job.name} didn't open`;
  if (job.status === "cancelled") return "Cancelled";
  return `Opening ${job.name}`;
}

function jobSubtitle(job: LaunchJob) {
  if (job.status === "queued" || job.status === "running") return "You can close this: it keeps going and the sidebar tracks it.";
  if (job.status === "done") return job.projects.length ? `With ${job.projects.length} project${job.projects.length > 1 ? "s" : ""} on its Desktop.` : undefined;
  return undefined;
}
