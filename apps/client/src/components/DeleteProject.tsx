import { useEffect, useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import clsx from "clsx";
import { backend } from "@/data";
import type { Project, ProjectStatus } from "@core/projects";
import { hasLocal } from "@/lib/machine";
import { useApp } from "@/lib/store";
import { Button, Modal } from "./ui";

/** Delete: a tombstone (it syncs). Offline it can also remove a clone wadd made
 *  here; a folder or drive of your own is never touched. GitHub keeps the repository. */
export function DeleteProject({ project: p, status, onClose }: { project: Project | null; status?: ProjectStatus | null; onClose: () => void }) {
  const toast = useApp((s) => s.toast);
  const loadProjects = useApp((s) => s.loadProjects);
  const [purge, setPurge] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const offline = hasLocal;
  // Only wadd's own folders: a clone, or an empty folder from before.
  const ours = !!p && (p.legacy || p.source.kind === "git");

  useEffect(() => {
    setPurge(false);
    setError(null);
  }, [p?.id]);

  const remove = async () => {
    if (!p) return;
    setBusy(true);
    setError(null);
    try {
      const { purged } = await backend.deleteProject(p.id, { purge: ours && purge });
      await loadProjects().catch(() => {});
      toast({ title: "Project deleted", body: purged ? `${p.name}, and its folder on this machine` : p.name });
      onClose();
    } catch (e) {
      // e.g. 409: still mounted in a wadspace.
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const keeps =
    p?.source.kind === "folder"
      ? "The folder itself stays where it is."
      : p?.source.kind === "drive"
        ? "Nothing on the drive changes."
        : offline
          ? "The repository stays on GitHub."
          : "The repository stays on GitHub, and your machines' clones stay until removed there.";

  return (
    <Modal open={!!p} onClose={onClose} width={480} title={p && `Delete ${p.name}?`}>
      {p && (
        <div className="space-y-4">
          <p className="text-sm text-muted">
            {offline ? "Wadspaces stop offering it, and your other machines learn it's gone the next time they sync." : "Wadspaces stop offering it, and your machines learn it's gone the next time they sync."}{" "}
            {keeps}
          </p>
          {offline && ours && status?.git && (status.git.dirty || status.git.ahead > 0) && (
            <p className="rounded-xl bg-accent-2-soft px-3 py-2 text-sm ring-1 ring-accent-2/45">
              The clone here has {[status.git.dirty && "uncommitted changes", status.git.ahead > 0 && `${status.git.ahead} commit${status.git.ahead > 1 ? "s" : ""} not pushed`].filter(Boolean).join(" and ")}.
              Push them first if you want to keep them.
            </p>
          )}
          {offline && ours && status?.existsOnDisk && (
            <label className="flex cursor-pointer items-start gap-3 rounded-xl bg-surface-2 p-3 ring-1 ring-line">
              <input type="checkbox" checked={purge} onChange={(e) => setPurge(e.target.checked)} className="mt-0.5 size-4 accent-[var(--danger)]" />
              <span className="text-sm">
                Also delete {p.legacy ? "its folder" : "the clone"} on this machine
                <span className="block font-mono text-xs text-muted">{status.path}</span>
              </span>
            </label>
          )}
          {error && <p className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger ring-1 ring-danger/30">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="danger" onClick={remove} disabled={busy} className={clsx(purge && "bg-danger/10")}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />} {ours && purge ? "Delete project and folder" : "Delete project"}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
