// Image builds, tracked in the sidebar (ActivityTray) and the build log.
//
// Offline, wadd builds on the machine with podman. Where the backend can't
// build (the online app, or an older wadd), "Build" saves the wadspace and
// says what to do instead.
import { backend } from "@/data";
import { openWadspace } from "./launch";
import { useApp } from "./store";

/** An image build running in the background; the sidebar shows its progress and log. */
export interface BuildJob {
  id: string;
  wadspaceId: string;
  name: string;
  rebuild: boolean;
  progress: number; // 0..1
  lines: string[];
  status: "building" | "done" | "error";
  error?: string;
}

/**
 * Start building a wadspace that's already been saved. Runs in the background
 * (the sidebar and build log follow it); returns false when it didn't start.
 */
export async function startBuild(opts: { wadspaceId: string; name: string; rebuild: boolean }): Promise<boolean> {
  const { toast, addBuild, builds } = useApp.getState();
  if (!backend.caps.localBuild || !backend.startBuild) {
    toast({
      title: `Saved ${opts.name}`,
      body:
        backend.target === "offline"
          ? "This machine's wadd can't build yet (it needs a system update). Until then, download the build folder from the Builder's Dockerfile view."
          : "Build it in Wad Creator on your machine, or download the build folder from the Builder's Dockerfile view.",
      tone: "success",
    });
    return false;
  }
  if (builds.some((b) => b.wadspaceId === opts.wadspaceId && b.status === "building")) {
    toast({ title: "Already building", body: opts.name });
    return false;
  }
  try {
    const id = await backend.startBuild(opts.wadspaceId);
    // The backend's events fill in progress and log lines from here.
    if (!useApp.getState().builds.some((b) => b.id === id)) {
      addBuild({ id, wadspaceId: opts.wadspaceId, name: opts.name, rebuild: opts.rebuild, progress: 0, lines: [], status: "building" });
    } else {
      useApp.getState().patchBuild(id, { rebuild: opts.rebuild });
    }
    return true;
  } catch (e) {
    toast({ title: "Couldn't start the build", body: (e as Error).message, tone: "error" });
    return false;
  }
}

export async function cancelBuild(id: string) {
  try {
    await backend.cancelBuild?.(id);
  } catch (e) {
    useApp.getState().toast({ title: "Couldn't cancel", body: (e as Error).message, tone: "error" });
  }
}

export function openBuilt(wadspaceId: string) {
  const ws = useApp.getState().wadspaces.find((w) => w.id === wadspaceId);
  if (ws) openWadspace(ws);
}
