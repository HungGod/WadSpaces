// Opening, downloading and focusing wadspaces, from any card or page.
//
// Offline (the app on a WadSpaces machine) "open" hands the screen to the
// wadspace: wadd starts it if needed and switches the kiosk to it. With
// projects, that's a launch: wadd gets the image and the projects' folders
// ready, mounts them and starts it (the Run dialog picks the projects, the
// sidebar follows it). Online it queues a switch for the chosen machine
// through the relay.
import { backend } from "@/data";
import { RestartNeeded, type LaunchPart } from "@/data/backend";
import { THIS_MACHINE, useApp } from "./store";
import type { Template } from "./templates";
import type { Wadspace } from "./types";
import { useUi } from "./ui";
import { hasAccount, isThisMachine } from "./machine";

/** A launch on this machine; the sidebar and the Run dialog show its parts. */
export interface LaunchJob {
  id: string;
  wadspaceId: string;
  name: string;
  /** Project ids it mounts. */
  projects: string[];
  status: "queued" | "running" | "done" | "error" | "cancelled";
  progress: number; // 0..1
  phase: string;
  error?: string;
  /** The image, then each project. */
  parts: LaunchPart[];
  lines: string[];
}

const machineLabel = (id: string) => useApp.getState().machines.find((m) => m.id === id)?.label ?? "that machine";

function fail(title: string, e: unknown) {
  useApp.getState().toast({ title, body: (e as Error).message, tone: "error" });
}

/** Whether opening this wadspace there goes through a launch (with projects). */
export function opensByLaunch(ws: Wadspace, machineId = useApp.getState().launchTarget) {
  return backend.caps.projects && isThisMachine(machineId) && !!ws.installed;
}

/** Open a wadspace on a machine (default: the launch target). */
export async function openWadspace(ws: Wadspace, machineId = useApp.getState().launchTarget) {
  const { toast, loadLastSession, loadMachines, builds, setWaitingFor, launches: running, machines, projects } = useApp.getState();
  // Still building: show its progress instead.
  if (builds.some((b) => b.wadspaceId === ws.id && b.status === "building")) return setWaitingFor(ws.id);
  if (opensByLaunch(ws, machineId)) {
    // Already launching: show how it's going.
    const job = running.find((l) => l.wadspaceId === ws.id && (l.status === "queued" || l.status === "running"));
    if (job) return useUi.getState().openRun(ws.id, job.id);
    const up = machines.find((m) => m.id === THIS_MACHINE)?.containers.some((c) => c.wadspaceId === ws.id && c.status === "running");
    // Running: back on screen with the projects it has. Otherwise pick them
    // (when there are any to pick).
    if (up) return void launchWadspace(ws, ws.mountedProjects ?? []).catch((e) => fail("Couldn't open", e));
    if (projects.length) return useUi.getState().openRun(ws.id);
    return void launchWadspace(ws, []).catch((e) => fail("Couldn't open", e));
  }
  try {
    await backend.open(machineId, ws.id);
    if (!isThisMachine(machineId)) toast({ title: `Opening on ${machineLabel(machineId)}`, body: ws.name, tone: "success" });
    loadMachines();
    loadLastSession();
  } catch (e) {
    fail("Couldn't open", e);
  }
}

/**
 * Launch a wadspace on this machine with these projects; the sidebar follows
 * it. Throws RestartNeeded when it's running with other projects (the caller
 * asks, then calls again with restart).
 */
export async function launchWadspace(ws: Wadspace, projectIds: string[], opts: { restart?: boolean } = {}): Promise<LaunchJob> {
  const { applyLaunch, loadLastSession } = useApp.getState();
  const progress = await backend.launch({ wadspaceId: ws.id, projectIds, restart: opts.restart });
  // wadd's events may have got here first, with log lines this summary doesn't carry.
  if (!useApp.getState().launches.some((l) => l.id === progress.id)) applyLaunch(progress);
  loadLastSession();
  return useApp.getState().launches.find((l) => l.id === progress.id)!;
}

export async function cancelLaunch(id: string) {
  try {
    await backend.cancelLaunch(id);
  } catch (e) {
    fail("Couldn't cancel", e);
  }
}

export { RestartNeeded };

/** Bring the running focus session back on screen. */
export function openFocusWindow() {
  const { focus, wadspaces, launchTarget } = useApp.getState();
  const ws = focus && wadspaces.find((w) => w.id === focus.wadspaceIds[0]);
  if (ws) openWadspace(ws, launchTarget);
}

/** Lock the machine into a focus session with these wadspaces. */
export async function startFocus(wadspaceIds: string[], minutes: number) {
  const { toast, loadFocus, loadLastSession, launchTarget } = useApp.getState();
  try {
    await backend.startFocus(launchTarget, wadspaceIds, minutes);
    await Promise.all([loadFocus(), loadLastSession()]);
    toast({
      title: "Focus session set up",
      body: `${minutes} minute${minutes === 1 ? "" : "s"} · the clock starts when you open the first one`,
      tone: "success",
    });
    return true;
  } catch (e) {
    fail("Couldn't start focus", e);
    return false;
  }
}

/** Pull a wadspace's image onto the launch target; progress shows in the sidebar. */
export async function startDownload(ws: Wadspace, { wait = false } = {}) {
  const { setWaitingFor, launchTarget, loadMachines } = useApp.getState();
  if (wait) setWaitingFor(ws.id);
  if (ws.local) return;
  try {
    await backend.container(launchTarget, ws.id, "download");
    loadMachines();
  } catch (e) {
    fail("Couldn't download", e);
  }
}

export async function transfer(ws: Wadspace, kind: "pull" | "remove-local") {
  const { toast, launchTarget, loadWadspaces } = useApp.getState();
  try {
    if (kind === "pull") return await startDownload(ws);
    await backend.container(launchTarget, ws.id, "remove");
    await loadWadspaces();
    toast({ title: "Removed from this machine", body: ws.name, tone: "success" });
  } catch (e) {
    fail("Couldn't do that", e);
  }
}

/** What the user hands a template at launch: for AI wadspaces, the prompt to start on. */
export interface LaunchExtras {
  prompt?: string;
}

const QUICK_LAUNCH_SOON = "Quick Launch is coming soon. Open the template in the Builder to make it your own.";

export async function quickLaunch(_t: Template, _extras?: LaunchExtras): Promise<Wadspace | undefined> {
  useApp.getState().toast({ title: "Coming soon", body: QUICK_LAUNCH_SOON });
  return undefined;
}

export async function downloadTemplate(_t: Template) {
  useApp.getState().toast({ title: "Coming soon", body: QUICK_LAUNCH_SOON });
}

/** Remove a wadspace from the machines it's on, then delete it. */
export async function discardWadspace(ws: Wadspace) {
  const { machines, toast, loadWadspaces, loadMachines } = useApp.getState();
  try {
    for (const m of machines) {
      if (m.containers.some((c) => c.wadspaceId === ws.id) && (isThisMachine(m.id) || hasAccount)) {
        await backend.container(m.id, ws.id, "remove").catch(() => {});
      }
    }
    await backend.deleteWadspace(ws.id);
    await Promise.all([loadWadspaces(), loadMachines()]);
    toast({ title: "Discarded", body: ws.name });
  } catch (e) {
    fail("Couldn't discard", e);
  }
}
