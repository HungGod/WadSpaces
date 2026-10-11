// A wadspace's container on a machine: its state (dot, phase, uptime) and
// the Restart / Stop / Start controls the Machines page's rows have.
import { useState } from "react";
import { Loader2, Power, RotateCw, Square } from "lucide-react";
import clsx from "clsx";
import { backend } from "@/data";
import type { ContainerAction } from "@/data/backend";
import { IconButton } from "@/components/ui";
import { uptime } from "@/lib/format";
import { isLocked, useApp } from "@/lib/store";
import { isThisMachine } from "@/lib/machine";
import type { Container, Machine } from "@/lib/types";

const PHASE: Record<string, string> = {
  idle: "Stopped",
  starting: "Starting",
  waiting: "Waiting for its desktop",
  ready: "Running",
  stopping: "Stopping",
  error: "Error",
};

export function phaseLabel(c: Container) {
  if (c.onScreen) return "On screen";
  if (c.phase === "idle" && c.status === "running") return "Running";
  return PHASE[c.phase ?? (c.status === "running" ? "ready" : "idle")] ?? c.phase ?? c.status;
}

/** A wadspace's state on a machine: the dot, the phase and how long it's been up. */
export function ContainerStatus({ c }: { c: Container }) {
  const on = c.status === "running";
  return (
    <span className="flex items-center gap-1.5">
      <span className={clsx("size-1.5 rounded-full", c.phase === "error" ? "bg-danger" : on ? "bg-accent shadow-[0_0_8px_var(--accent)]" : c.phase && c.phase !== "idle" ? "bg-accent-2" : "bg-faint")} />
      {phaseLabel(c)}
      {on && c.phase !== "error" && ` · up ${uptime(c.startedAt)}`}
    </span>
  );
}

/** Restart / Stop / Start for a wadspace on a machine (the Machines page's rows). */
export function ContainerControls({ m, c }: { m: Machine; c: Container }) {
  const focus = useApp((s) => s.focus);
  const toast = useApp((s) => s.toast);
  const loadMachines = useApp((s) => s.loadMachines);
  const [busy, setBusy] = useState<ContainerAction | null>(null);
  const here = isThisMachine(m.id);
  const up = m.status === "online";
  const on = c.status === "running";
  const locked = isLocked(focus, c.wadspaceId);

  const act = async (action: ContainerAction) => {
    setBusy(action);
    try {
      await backend.container(m.id, c.id, action);
      if (!here) toast({ title: "Sent", body: `${action} → ${m.label}` });
      loadMachines();
    } catch (e) {
      toast({ title: "Couldn't do that", body: (e as Error).message, tone: "error" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      {on ? (
        <>
          <IconButton label="Restart" disabled={!up || busy === "restart"} onClick={() => act("restart")}>
            {busy === "restart" ? <Loader2 className="size-4 animate-spin" /> : <RotateCw className="size-4" />}
          </IconButton>
          <IconButton label="Stop" disabled={!up || busy === "stop"} onClick={() => act("stop")}>
            <Square className="size-3.5 fill-current" />
          </IconButton>
        </>
      ) : (
        <IconButton label="Start in the background" disabled={!up || locked || busy === "start"} onClick={() => act("start")}>
          <Power className="size-4" />
        </IconButton>
      )}
    </>
  );
}
