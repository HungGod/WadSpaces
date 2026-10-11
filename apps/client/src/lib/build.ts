// Layer image builds, tracked in the sidebar (ActivityTray) and its build log.
// The Builder starts them (saving a template or customization builds it, and
// launching a wadspace builds what it needs); wadd builds on the machine with
// podman, offline from its events, online through the relay.
import { backend } from "@/data";
import { openWadspace } from "./launch";
import { useApp } from "./store";

/** An image build running in the background; the sidebar shows its progress and log. */
export interface BuildJob {
  id: string;
  /** The layer's key for a layer build. */
  wadspaceId: string;
  name: string;
  rebuild: boolean;
  progress: number; // 0..1
  lines: string[];
  status: "building" | "done" | "error";
  error?: string;
  /** A layer's image ("template:<id>" / "custom:<id>"). */
  layer?: string | null;
}

export async function cancelBuild(id: string) {
  try {
    await backend.cancelBuild?.(id);
  } catch (e) {
    useApp.getState().toast({ title: "Couldn't cancel", body: (e as Error).message, tone: "error" });
  }
}

/** Opens the wadspace a notice is about, when it's one. */
export function openBuilt(wadspaceId: string) {
  const w = useApp.getState().wadspaces.find((x) => x.id === wadspaceId && !x.deletedAt);
  if (w) void openWadspace(w);
}
