// wadd's build and launch jobs, as the app tracks them (its events and
// listings, offline and in the machine app).
import type { BuildUpdate, LaunchUpdate } from "@/lib/wadd";
import type { BuildProgress, LaunchProgress } from "../backend";

/** wadd's build job, as the app tracks builds. */
export function toProgress(u: BuildUpdate): BuildProgress {
  const status = u.status === "done" ? "done" : u.status === "error" || u.status === "cancelled" ? "error" : "building";
  return {
    id: u.id,
    wadspaceId: u.wsId,
    name: u.name,
    status,
    progress: u.progress,
    error: u.status === "cancelled" ? "Cancelled" : u.error,
    from: u.from,
    lines: u.lines,
    restartRequired: u.restartRequired,
    layer: u.layer ?? null,
  };
}

/** wadd's launch job, as the app tracks launches. */
export function toLaunchProgress(u: LaunchUpdate): LaunchProgress {
  return {
    id: u.id,
    wadspaceId: u.wsId,
    name: u.name,
    projects: u.projects ?? [],
    status: u.status,
    progress: u.progress,
    phase: u.phase,
    error: u.status === "cancelled" ? "Cancelled" : u.error,
    parts: u.parts,
    from: u.from ?? 0,
    lines: u.lines ?? [],
  };
}
