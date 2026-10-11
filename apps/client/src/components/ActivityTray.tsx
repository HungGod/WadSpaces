// Background work in the sidebar: layer image builds (with their logs)
// and launches getting wadspaces ready.
import { Link } from "react-router";
import { useEffect, useRef } from "react";
import { motion } from "motion/react";
import { Check, CircleAlert, Folder, Hammer, HardDrive, Loader2, Play, Rocket, X } from "lucide-react";
import clsx from "clsx";
import { imageRef, type LayerKey } from "@core/layers";
import { cancelBuild, openBuilt, type BuildJob } from "@/lib/build";
import type { LaunchJob } from "@/lib/launch";
import { cancelLaunch } from "@/lib/launch";
import { useApp } from "@/lib/store";
import { Button, Modal, Progress } from "./ui";

/** Background work in the sidebar: image builds and launches. */
export function ActivityTray({ narrow }: { narrow: boolean }) {
  return (
    <>
      <BuildsTray narrow={narrow} />
      <LaunchesTray narrow={narrow} />
    </>
  );
}

/** A progress ring for the collapsed sidebar. */
function Ring({ value, icon, count, label, title, onClick, done }: { value: number; icon: React.ReactNode; count: number; label: string; title: string; onClick: () => void; done?: boolean }) {
  const r = 15;
  const c = 2 * Math.PI * r;
  return (
    <button type="button" onClick={onClick} title={title} aria-label={label} className="relative mx-auto grid size-10 place-items-center rounded-xl text-accent hover:bg-surface-2">
      <svg viewBox="0 0 36 36" className="absolute inset-0.5 -rotate-90">
        <circle cx="18" cy="18" r={r} fill="none" strokeWidth="2.5" className="stroke-surface-3" />
        <circle cx="18" cy="18" r={r} fill="none" strokeWidth="2.5" strokeLinecap="round" className="stroke-accent transition-[stroke-dashoffset] duration-300" strokeDasharray={c} strokeDashoffset={c * (1 - value)} />
      </svg>
      {done ? <Check className="size-4" strokeWidth={3} /> : icon}
      {count > 1 && <span className="absolute -right-0.5 -top-0.5 grid size-4 place-items-center rounded-full bg-accent text-[10px] font-bold text-accent-fg">{count}</span>}
    </button>
  );
}

function BuildsTray({ narrow }: { narrow: boolean }) {
  const builds = useApp((s) => s.builds);
  const setBuildLog = useApp((s) => s.setBuildLog);
  const removeBuild = useApp((s) => s.removeBuild);
  if (!builds.length) return null;

  if (narrow) {
    const active = builds.filter((b) => b.status === "building");
    const avg = active.length ? active.reduce((n, b) => n + b.progress, 0) / active.length : 1;
    return (
      <Ring
        value={avg}
        icon={<Hammer className="size-4" />}
        count={builds.length}
        done={!active.length}
        label={active.length ? `${active.length} build${active.length > 1 ? "s" : ""} running` : "Builds finished"}
        title={builds.map((b) => `${b.name} · ${statusText(b)}`).join("\n")}
        onClick={() => setBuildLog((active[0] ?? builds[builds.length - 1]).id)}
      />
    );
  }

  return (
    <div className="rounded-2xl bg-surface/60 p-2 ring-1 ring-line">
      <div className="flex items-center gap-1.5 px-1.5 pb-1 pt-0.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-faint">
        <Hammer className="size-3.5 text-accent" /> Builds
      </div>
      {builds.map((b) => (
        <div key={b.id} className="group flex items-center gap-1 rounded-xl hover:bg-surface-2">
          <button type="button" onClick={() => setBuildLog(b.id)} className="min-w-0 flex-1 px-1.5 py-1.5 text-left" title="Show build log">
            <span className="flex items-baseline justify-between gap-2 text-xs">
              <span className="min-w-0 truncate">
                <span className="font-medium">{b.name}</span>
                {b.layer && <span className="block truncate font-mono text-[10.5px] text-faint">{imageRef(b.layer as LayerKey)}</span>}
              </span>
              <span className={clsx("flex shrink-0 items-center gap-1 tabular-nums", b.status === "done" ? "font-medium text-fg dark:text-accent" : b.status === "error" ? "text-accent-2" : "text-faint")}>
                {b.status === "done" && <Check className="size-3" strokeWidth={3} />}
                {b.status === "error" && <CircleAlert className="size-3" />}
                {statusText(b)}
              </span>
            </span>
            {b.status === "building" && <Progress value={b.progress} className="mt-1.5 !h-1" />}
          </button>
          {b.status === "done" && !b.layer && (
            <button type="button" onClick={() => openBuilt(b.wadspaceId)} className="grid size-7 shrink-0 place-items-center rounded-lg text-muted hover:bg-surface-3 hover:text-fg" aria-label={`Open ${b.name}`} title="Open">
              <Play className="size-3.5 fill-current" />
            </button>
          )}
          {b.status !== "building" && (
            <button type="button" onClick={() => removeBuild(b.id)} className="mr-1 grid size-7 shrink-0 place-items-center rounded-lg text-faint hover:bg-surface-3 hover:text-fg" aria-label="Dismiss" title="Dismiss">
              <X className="size-3.5" />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/** Wadspaces opening with projects: the image and each project's folder, then the start. */
function LaunchesTray({ narrow }: { narrow: boolean }) {
  const launches = useApp((s) => s.launches);
  const removeLaunch = useApp((s) => s.removeLaunch);
  const setLaunchLog = useApp((s) => s.setLaunchLog);
  if (!launches.length) return null;
  const isActive = (l: LaunchJob) => l.status === "queued" || l.status === "running";

  if (narrow) {
    const active = launches.filter(isActive);
    const avg = active.length ? active.reduce((n, l) => n + l.progress, 0) / active.length : 1;
    const first = active[0] ?? launches[launches.length - 1];
    return (
      <Ring
        value={avg}
        icon={<Rocket className="size-4" />}
        count={launches.length}
        done={!active.length}
        label={active.length ? `${active.length} wadspace${active.length > 1 ? "s" : ""} opening` : "Opened"}
        title={launches.map((l) => `${l.name} · ${launchText(l)}`).join("\n")}
        onClick={() => setLaunchLog(first.id)}
      />
    );
  }

  return (
    <div className="rounded-2xl bg-surface/60 p-2 ring-1 ring-line">
      <div className="flex items-center gap-1.5 px-1.5 pb-1 pt-0.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-faint">
        <Rocket className="size-3.5 text-accent" /> Opening
      </div>
      {launches.map((l) => (
        <div key={l.id} className="group flex items-start gap-1 rounded-xl hover:bg-surface-2">
          <button type="button" onClick={() => setLaunchLog(l.id)} className="min-w-0 flex-1 px-1.5 py-1.5 text-left" title="Show progress">
            <span className="flex items-baseline justify-between gap-2 text-xs">
              <span className="truncate font-medium">{l.name}</span>
              <span className={clsx("flex shrink-0 items-center gap-1 tabular-nums", l.status === "done" ? "font-medium text-fg dark:text-accent" : l.status === "error" ? "text-accent-2" : "text-faint")}>
                {l.status === "done" && <Check className="size-3" strokeWidth={3} />}
                {l.status === "error" && <CircleAlert className="size-3" />}
                {launchText(l)}
              </span>
            </span>
            {isActive(l) && (
              <>
                {/* One line per part: the image, then each project. */}
                <span className="mt-1 block space-y-0.5">
                  {l.parts.map((p) => (
                    <span key={p.key} className="flex items-center gap-1.5 text-[11px] text-muted">
                      {p.state === "done" ? (
                        <Check className="size-3 shrink-0 text-accent" strokeWidth={3} />
                      ) : p.state === "error" ? (
                        <CircleAlert className="size-3 shrink-0 text-accent-2" />
                      ) : p.state === "working" ? (
                        <Loader2 className="size-3 shrink-0 animate-spin" />
                      ) : p.kind === "image" ? (
                        <HardDrive className="size-3 shrink-0 text-faint" />
                      ) : (
                        <Folder className="size-3 shrink-0 text-faint" />
                      )}
                      <span className="truncate">{p.kind === "image" ? "Image" : p.name}</span>
                      {p.state === "working" && p.progress != null && <span className="ml-auto shrink-0 tabular-nums text-faint">{Math.floor(p.progress * 100)}%</span>}
                    </span>
                  ))}
                </span>
                <Progress value={l.progress} className="mt-1.5 !h-1" />
              </>
            )}
          </button>
          {!isActive(l) && (
            <button type="button" onClick={() => removeLaunch(l.id)} className="mr-1 mt-1 grid size-7 shrink-0 place-items-center rounded-lg text-faint hover:bg-surface-3 hover:text-fg" aria-label="Dismiss" title="Dismiss">
              <X className="size-3.5" />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

const launchText = (l: LaunchJob) =>
  l.status === "done" ? "Open" : l.status === "error" ? "Failed" : l.status === "cancelled" ? "Cancelled" : l.phase === "starting" ? "Starting" : `${Math.floor(l.progress * 100)}%`;

const statusText = (b: BuildJob) => (b.status === "done" ? "Ready" : b.status === "error" ? "Failed" : `${Math.floor(b.progress * 100)}%`);

/** The log for one build. Closing it never stops the build; it keeps going in the sidebar. */
export function BuildLog() {
  const job = useApp((s) => s.builds.find((b) => b.id === s.buildLog));
  const setBuildLog = useApp((s) => s.setBuildLog);
  const removeBuild = useApp((s) => s.removeBuild);
  const log = useRef<HTMLDivElement>(null);
  const close = () => setBuildLog(null);

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [job?.lines.length]);

  return (
    <Modal
      open={!!job}
      onClose={close}
      width={580}
      title={job && (job.status === "done" ? `${job.name} is ready` : job.status === "error" ? "Build failed" : `${job.rebuild ? "Rebuilding" : "Building"} ${job.name}`)}
      subtitle={job && (job.status === "building" ? "You can close this: the build keeps going and the sidebar tracks it." : job.status === "done" ? (job.layer ? `Built on the machine as ${imageRef(job.layer as LayerKey)}.` : "Built on this machine.") : job.error)}
    >
      {job && (
        <>
          <div ref={log} className="h-64 overflow-y-auto rounded-2xl bg-[#07040f] p-4 font-mono text-[12px] leading-relaxed text-[#e9e3ff] ring-1 ring-white/10">
            {job.lines.map((l, i) => (
              <motion.div key={i} initial={{ opacity: 0 }} animate={{ opacity: 1 }} className={clsx("whitespace-pre-wrap break-words", l.startsWith("✓") && "text-[#c6ff1f]", l.startsWith("✗") && "text-[#ff6b9b]", /^STEP \d/.test(l) && "font-semibold text-white", /^(\s|»)/.test(l) && "text-white/60")}>
                {l}
              </motion.div>
            ))}
            {job.status === "building" && <span className="ws-caret text-[#c6ff1f]" />}
            {job.status === "error" && !job.lines.at(-1)?.startsWith("✗") && <div className="text-[#ff6b9b]">✗ {job.error}</div>}
          </div>
          <Progress value={job.progress} className="mt-4" />

          <div className="mt-5 flex flex-wrap justify-end gap-2">
            {job.status === "building" ? (
              <>
                <Button variant="ghost" onClick={() => cancelBuild(job.id)}>
                  Cancel build
                </Button>
                <Button onClick={close}>Hide</Button>
              </>
            ) : (
              <>
                <Button
                  variant="ghost"
                  onClick={() => {
                    removeBuild(job.id);
                  }}
                >
                  Dismiss
                </Button>
                {job.status === "done" && job.layer && (
                  <Link to="/builder" onClick={close}>
                    <Button>Open the Builder</Button>
                  </Link>
                )}
                {job.status === "done" && !job.layer && (
                  <>
                    <Link to="/machines" onClick={close}>
                      <Button>View in Machines</Button>
                    </Link>
                    <Button
                      variant="primary"
                      onClick={() => {
                        close();
                        openBuilt(job.wadspaceId);
                      }}
                    >
                      <Play className="size-4 fill-current" /> Open now
                    </Button>
                  </>
                )}
              </>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}

/** A launch, followed: the image and each project's folder getting ready, then the start, with its log. */
export function LaunchLog() {
  const job = useApp((s) => s.launches.find((l) => l.id === s.launchLog));
  const setLaunchLog = useApp((s) => s.setLaunchLog);
  const removeLaunch = useApp((s) => s.removeLaunch);
  const log = useRef<HTMLDivElement>(null);
  const close = () => setLaunchLog(null);
  const active = !!job && (job.status === "queued" || job.status === "running");

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [job?.lines.length]);

  return (
    <Modal
      open={!!job}
      onClose={close}
      width={580}
      title={job && (job.status === "done" ? `${job.name} is open` : job.status === "error" ? `${job.name} didn't start` : job.status === "cancelled" ? "Cancelled" : `Opening ${job.name}`)}
      subtitle={job && (active ? "You can close this: it keeps going and the sidebar tracks it." : job.error)}
    >
      {job && (
        <>
          <div className="space-y-1">
            {job.parts.map((p) => (
              <div key={p.key} className="flex items-center gap-2 rounded-xl bg-surface-2 px-3 py-2 text-sm ring-1 ring-line">
                {p.state === "done" ? (
                  <Check className="size-4 shrink-0 text-accent" strokeWidth={3} />
                ) : p.state === "error" ? (
                  <CircleAlert className="size-4 shrink-0 text-accent-2" />
                ) : p.state === "working" ? (
                  <Loader2 className="size-4 shrink-0 animate-spin" />
                ) : p.kind === "image" ? (
                  <HardDrive className="size-4 shrink-0 text-faint" />
                ) : (
                  <Folder className="size-4 shrink-0 text-faint" />
                )}
                <span className="min-w-0 flex-1 truncate">{p.kind === "image" ? "Its image" : p.name}</span>
                <span className="shrink-0 text-xs text-muted">{p.message ?? (p.state === "working" && p.progress != null ? `${Math.floor(p.progress * 100)}%` : "")}</span>
              </div>
            ))}
          </div>
          <div ref={log} className="mt-3 h-48 overflow-y-auto rounded-2xl bg-[#07040f] p-4 font-mono text-[12px] leading-relaxed text-[#e9e3ff] ring-1 ring-white/10">
            {job.lines.map((l, i) => (
              <div key={i} className="whitespace-pre-wrap break-words">
                {l}
              </div>
            ))}
          </div>
          <Progress value={job.progress} className="mt-4" />
          <div className="mt-5 flex justify-end gap-2">
            {active ? (
              <>
                <Button variant="ghost" onClick={() => void cancelLaunch(job.id)}>
                  Cancel
                </Button>
                <Button onClick={close}>Hide</Button>
              </>
            ) : (
              <Button variant="ghost" onClick={() => removeLaunch(job.id)}>
                Dismiss
              </Button>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}
