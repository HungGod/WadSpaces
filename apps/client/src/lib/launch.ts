// Opening wadspaces, from any card or page, and the launches that follow.
//
// Everything goes through the launcher's path (backend.launchItems): the
// wadspace is installed as it is now, its layer built where it needs it, its
// projects' folders made ready, and it starts and takes the screen. Offline
// that's wadd on this machine; online, a launch-run relay command to the
// default machine. Launches report their progress in the sidebar.
import { backend } from "@/data";
import { RestartNeeded, type LaunchPart } from "@/data/backend";
import type { WadspaceV2 } from "@core/layers";
import { useApp } from "./store";

/** A launch on the machine; the sidebar shows its parts. */
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

function fail(title: string, e: unknown) {
  useApp.getState().toast({ title, body: (e as Error).message, tone: "error" });
}

/** Opens a wadspace: launched with the folders it was constructed with (or
 *  back on screen when it runs). */
export async function openWadspace(w: WadspaceV2) {
  await useApp.getState().launch([{ kind: "wadspace", wadspaceId: w.id }], null);
}

export async function cancelLaunch(id: string) {
  try {
    await backend.cancelLaunch(id);
  } catch (e) {
    fail("Couldn't cancel", e);
  }
}

export { RestartNeeded };

/** Brings the running focus session's first pick back on screen. */
export function openFocusWindow() {
  const { focus, wadspaces } = useApp.getState();
  const w = focus && wadspaces.find((x) => x.id === focus.wadspaceIds[0]);
  if (w) void openWadspace(w);
}
