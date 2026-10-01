import { useEffect, useMemo, useState } from "react";
import { Eye, Folder, History, Laptop, Loader2, MonitorPlay, Radio, Server } from "lucide-react";
import clsx from "clsx";
import { backend } from "@/data";
import { THIS_MACHINE, useApp } from "@/lib/store";
import type { ContainerRun } from "@/lib/types";
import { Avatar } from "./ui";

const MODE = {
  local: { label: "Local", icon: MonitorPlay },
  stream: { label: "Streamed", icon: Radio },
  remote: { label: "Remote", icon: Server },
} as const;

/** "1h 12m", "14m", "<1m" */
export function duration(ms: number) {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "<1m";
  const h = Math.floor(m / 60);
  return h ? `${h}h ${m % 60}m` : `${m}m`;
}

const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

function dayLabel(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

/**
 * Container history, grouped by day. For a wadspace it says where each run happened;
 * for a machine it says what ran there, who started it, and who else had access.
 */
export function RunHistory({ wadspaceId, machineId, limit = 12 }: { wadspaceId?: string; machineId?: string; limit?: number }) {
  const machines = useApp((s) => s.machines);
  const users = useApp((s) => s.users);
  const me = useApp((s) => s.user);
  const projects = useApp((s) => s.projects);
  const [runs, setRuns] = useState<ContainerRun[] | null>(null);
  const [shown, setShown] = useState(limit);
  const [, tick] = useState(0);
  const query = wadspaceId ? `wadspace:${wadspaceId}` : `machine:${machineId}`;

  // Refresh alongside the machine list (it polls on the Manager) and keep live durations ticking.
  useEffect(() => {
    let off = false;
    backend
      .runs(wadspaceId ? { wadspaceId } : { machineId })
      .then((r) => !off && setRuns(r))
      .catch(() => !off && setRuns([]));
    return () => {
      off = true;
    };
  }, [query, machines]);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => setShown(limit), [query, limit]);

  const groups = useMemo(() => {
    const out: { day: string; runs: ContainerRun[] }[] = [];
    for (const r of (runs ?? []).slice(0, shown)) {
      const day = dayLabel(r.startedAt);
      if (out.at(-1)?.day === day) out.at(-1)!.runs.push(r);
      else out.push({ day, runs: [r] });
    }
    return out;
  }, [runs, shown]);

  if (!runs) {
    return (
      <div className="grid place-items-center py-8 text-muted">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }
  if (!runs.length) {
    return (
      <div className="flex flex-col items-center gap-2 py-8 text-center text-sm text-muted">
        <History className="size-5 text-faint" />
        {wadspaceId ? "This wadspace hasn't run anywhere yet." : "Nothing has run on this machine yet."}
      </div>
    );
  }

  const machineLabel = (id: string) => machines.find((m) => m.id === id)?.label ?? id;
  const person = (name: string) => users.find((u) => u.username === name);

  return (
    <div>
      {groups.map((g) => (
        <div key={g.day}>
          <div className="sticky top-0 z-[1] bg-surface/95 px-1 pb-1.5 pt-3 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-faint backdrop-blur">{g.day}</div>
          <ul className="space-y-1">
            {g.runs.map((r) => {
              const live = r.endedAt === null;
              const Mode = MODE[r.mode];
              const MachineIcon = r.machineId === THIS_MACHINE ? Laptop : Server;
              const who = person(r.user);
              return (
                <li key={r.id} className="rounded-xl px-2 py-2 hover:bg-surface-2/70">
                  <div className="flex items-center gap-3">
                    <div className="w-16 shrink-0 text-xs tabular-nums text-muted">{time(r.startedAt)}</div>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-1.5 text-[13px] font-medium">
                        {machineId ? (
                          <span className="truncate">{r.wadspaceName}</span>
                        ) : (
                          <>
                            <MachineIcon className="size-3.5 shrink-0 text-muted" />
                            <span className="truncate">{machineLabel(r.machineId)}</span>
                          </>
                        )}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-muted">
                        <span className="flex items-center gap-1">
                          <Mode.icon className="size-3" /> {Mode.label}
                        </span>
                        {(machineId || r.user !== me?.username) && (
                          <span className="flex items-center gap-1">
                            <Avatar user={who ?? { displayName: r.user, color: "#888" }} size={14} className="ring-0" /> {who?.displayName ?? r.user}
                          </span>
                        )}
                        {!!r.projects?.length && (
                          <span className="flex min-w-0 items-center gap-1" title="Projects it had">
                            <Folder className="size-3 shrink-0" />
                            <span className="truncate">{r.projects.map((id) => projects.find((p) => p.id === id)?.name ?? "deleted").join(", ")}</span>
                          </span>
                        )}
                        <span className="text-faint">
                          {time(r.startedAt)}–{live ? "now" : time(r.endedAt!)}
                        </span>
                      </div>
                    </div>
                    <span className={clsx("shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-semibold tabular-nums", live ? "bg-accent-soft text-accent" : "bg-surface-2 text-muted ring-1 ring-line")}>
                      {live ? (
                        <span className="flex items-center gap-1">
                          <span className="size-1.5 animate-pulse rounded-full bg-accent" /> {duration(Date.now() - Date.parse(r.startedAt))}
                        </span>
                      ) : (
                        duration(Date.parse(r.endedAt!) - Date.parse(r.startedAt))
                      )}
                    </span>
                  </div>
                  {!!r.viewers?.length && (
                    <div className="ml-[76px] mt-1.5 flex flex-wrap gap-1.5">
                      {r.viewers.map((v, i) => {
                        const p = person(v.user);
                        return (
                          <span key={i} className="flex items-center gap-1.5 rounded-full bg-surface-2 py-0.5 pl-0.5 pr-2 text-[11px] text-muted ring-1 ring-line" title={`Joined ${time(v.joinedAt)}${v.leftAt ? `, left ${time(v.leftAt)}` : ", still watching"}`}>
                            {p ? <Avatar user={p} size={16} className="ring-0" /> : <Eye className="ml-1 size-3" />}
                            {p?.displayName ?? v.user} · {v.leftAt ? duration(Date.parse(v.leftAt) - Date.parse(v.joinedAt)) : "watching"}
                          </span>
                        );
                      })}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      {runs.length > shown && (
        <button type="button" onClick={() => setShown((n) => n + limit)} className="mt-2 w-full rounded-xl py-2 text-xs font-medium text-muted hover:bg-surface-2 hover:text-fg">
          Show older ({runs.length - shown} more)
        </button>
      )}
    </div>
  );
}
