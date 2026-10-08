// The Wadspaces Manager's actions on a wadspace: clone it, delete it, and
// restore it. Deleting is never for good: the wadspace is hidden, off the
// HUD and its Super+number freed, and the toast's Undo brings it back.
import { backend } from "@/data";
import { hasAccount, isThisMachine } from "./machine";
import { useApp } from "./store";
import type { Wadspace } from "./types";

function fail(title: string, e: unknown) {
  useApp.getState().toast({ title, body: (e as Error).message, tone: "error" });
}

/** The machines it's installed on that this app can act on. */
function machinesWith(ws: Wadspace, running = false) {
  return useApp
    .getState()
    .machines.filter((m) => (isThisMachine(m.id) || hasAccount) && m.containers.some((c) => c.wadspaceId === ws.id && (!running || c.status === "running")));
}

/** "Writing" → "Writing copy", "Writing copy" → "Writing copy 2", … */
function copyName(name: string, taken: string[]) {
  const base = name.replace(/ copy( \d+)?$/, "");
  for (let n = 1; ; n++) {
    const next = n === 1 ? `${base} copy` : `${base} copy ${n}`;
    if (!taken.includes(next)) return next;
  }
}

/**
 * A new wadspace just like this one, yours and private. Where the original is
 * installed on this machine the copy is installed with its image, so it opens
 * without a build.
 */
export async function cloneWadspace(ws: Wadspace): Promise<Wadspace | undefined> {
  const { toast, loadWadspaces, wadspaces, deletedWadspaces } = useApp.getState();
  try {
    const copy = await backend.createWadspace({
      name: copyName(ws.name, [...wadspaces, ...deletedWadspaces].map((w) => w.name)),
      description: ws.description,
      visibility: "private",
      layout: ws.layout,
      // Its own Super+number, port and image (its builds mustn't replace the original's).
      advanced: { ...ws.advanced, hotkey: null, port: null, image: undefined },
      ...(ws.agent && { agent: ws.agent }),
      ...(ws.dockerfile && { dockerfile: ws.dockerfile }),
    });
    const installed = !!ws.installed && (await backend.installCopy?.(copy, ws.id).catch(() => false));
    await loadWadspaces();
    toast({ title: `Cloned ${ws.name}`, body: installed ? `${copy.name} is ready to open` : `Build ${copy.name} to open it`, tone: "success" });
    return copy;
  } catch (e) {
    fail("Couldn't clone", e);
  }
}

/** Delete, not for good: it's stopped and hidden; the toast's Undo restores it. */
export async function trashWadspace(ws: Wadspace) {
  const { toast, patchWadspace, loadMachines } = useApp.getState();
  try {
    for (const m of machinesWith(ws, true)) await backend.container(m.id, ws.id, "stop").catch(() => {});
    await patchWadspace(ws.id, { deletedAt: new Date().toISOString() });
    loadMachines().catch(() => {});
    toast({ title: "Wadspace deleted", body: ws.name, action: { label: "Undo", onClick: () => restoreWadspace(ws) } });
  } catch (e) {
    fail("Couldn't delete", e);
  }
}

export async function restoreWadspace(ws: Wadspace) {
  try {
    await useApp.getState().patchWadspace(ws.id, { deletedAt: null });
  } catch (e) {
    fail("Couldn't restore", e);
  }
}
