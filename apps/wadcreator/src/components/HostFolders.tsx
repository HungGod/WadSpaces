import { useCallback, useEffect, useState } from "react";
import { ArrowUp, ChevronRight, Folder, HardDrive, Loader2, Usb } from "lucide-react";
import clsx from "clsx";
import { backend } from "@/data";
import type { FolderListing, HostDrive } from "@/data/backend";
import type { Project, ProjectSource } from "@core/projects";
import { formatBytes } from "@/lib/wadd";
import { ProjectForm } from "./ProjectDialog";
import { Button, Modal } from "./ui";

// Offline only: folder and drive projects are picked on the machine they're on
// (wadd's /api/fs/browse and /api/drives).

/**
 * Subfolders, one level at a time, from the places wadd lets you pick (no
 * path) or a drive's root. `onPick` gets the folder showing, when it can be
 * picked.
 */
function FolderBrowser({ drive, rootLabel, pickLabel, onPick }: { drive?: HostDrive; rootLabel: string; pickLabel: (path: string | null) => string; onPick: (path: string) => void }) {
  const [path, setPath] = useState<string | null>(drive ? "" : null);
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const go = useCallback(
    async (to: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const l = await backend.browseFolders!({ ...(drive && { drive: drive.uuid }), ...(to && { path: to }) });
        setListing(l);
        setPath(drive ? (l.path ?? "") : (l.path ?? null));
      } catch (e) {
        // e.g. 403: outside the folders this machine lets wadspaces open.
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [drive],
  );

  useEffect(() => {
    go(null);
  }, [go]);

  // Places › var › home › wad, each a step back up.
  const parts = (path ?? "").split("/").filter(Boolean);
  const crumbs = parts.map((name, i) => ({ name, to: drive ? parts.slice(0, i + 1).join("/") : `/${parts.slice(0, i + 1).join("/")}` }));
  const atRoot = drive ? !path : path === null;
  const canPick = drive ? true : !!path;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1 rounded-xl bg-surface-2 px-2.5 py-2 text-xs ring-1 ring-line">
        <button type="button" onClick={() => go(null)} className={clsx("rounded-md px-1.5 py-0.5 font-medium hover:bg-surface-3", atRoot ? "text-fg" : "text-muted")}>
          {rootLabel}
        </button>
        {crumbs.map((c, i) => (
          <span key={c.to} className="flex items-center gap-1">
            <ChevronRight className="size-3 text-faint" />
            <button type="button" onClick={() => go(c.to)} className={clsx("rounded-md px-1.5 py-0.5 font-mono hover:bg-surface-3", i === crumbs.length - 1 ? "text-fg" : "text-muted")}>
              {c.name}
            </button>
          </span>
        ))}
        {loading && <Loader2 className="ml-auto size-3.5 animate-spin text-muted" />}
      </div>
      {error && <p className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger ring-1 ring-danger/30">{error}</p>}
      <div className="h-64 space-y-1 overflow-y-auto rounded-xl p-1 ring-1 ring-line">
        {!atRoot && (
          <button
            type="button"
            onClick={() => go(listing?.parent ?? null)}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm text-muted hover:bg-surface-2 hover:text-fg"
          >
            <ArrowUp className="size-4" /> Up
          </button>
        )}
        {listing?.dirs.map((d) => (
          <button key={d.path} type="button" onClick={() => go(d.path)} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-surface-2">
            <Folder className="size-4 shrink-0 text-accent" />
            <span className="truncate">{d.name}</span>
          </button>
        ))}
        {listing && !listing.dirs.length && <p className="px-2.5 py-6 text-center text-xs text-muted">No folders in here.</p>}
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate font-mono text-xs text-muted">{drive ? `/${path ?? ""}` : (path ?? "")}</span>
        <Button variant="primary" disabled={!canPick || loading} onClick={() => onPick(path ?? "")}>
          {pickLabel(path)}
        </Button>
      </div>
    </div>
  );
}

/** Folder on this machine: browse to it, then the small form. */
export function AddFolderDialog({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded?: (p: Project) => void }) {
  const [source, setSource] = useState<ProjectSource | null>(null);
  useEffect(() => {
    if (open) setSource(null);
  }, [open]);
  return (
    <Modal open={open} onClose={onClose} width={560} title="Folder on this machine" subtitle={source ? "How wadspaces open it." : "A folder that's here already. Wadspaces on this machine open it where it is."}>
      {source ? (
        <ProjectForm
          source={source}
          cancelLabel="Back"
          onCancel={() => setSource(null)}
          onSaved={(p) => {
            onAdded?.(p);
            onClose();
          }}
        />
      ) : (
        <FolderBrowser rootLabel="Places" pickLabel={() => "Use this folder"} onPick={(path) => setSource({ kind: "folder", machineId: "", machineName: "", path })} />
      )}
    </Modal>
  );
}

/** Drive: pick one plugged in here, optionally a folder inside it, then the small form. */
export function AddDriveDialog({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded?: (p: Project) => void }) {
  const [drives, setDrives] = useState<HostDrive[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drive, setDrive] = useState<HostDrive | null>(null);
  const [source, setSource] = useState<ProjectSource | null>(null);

  useEffect(() => {
    if (!open) return;
    setDrive(null);
    setSource(null);
    setError(null);
    setDrives(null);
    backend.listDrives!()
      .then(setDrives)
      .catch((e) => setError((e as Error).message));
  }, [open]);

  const name = (d: HostDrive) => d.label || d.model || d.uuid;
  const subtitle = source ? "How wadspaces open it." : drive ? "The whole drive, or a folder in it." : "Wadspaces open it on whichever machine it's plugged into.";

  return (
    <Modal open={open} onClose={onClose} width={560} title={drive ? `Drive ${name(drive)}` : "Drive"} subtitle={subtitle}>
      {source ? (
        <ProjectForm
          source={source}
          cancelLabel="Back"
          onCancel={() => setSource(null)}
          onSaved={(p) => {
            onAdded?.(p);
            onClose();
          }}
        />
      ) : drive ? (
        <div className="space-y-3">
          <FolderBrowser
            drive={drive}
            rootLabel={name(drive)}
            pickLabel={(path) => (path ? "Use this folder" : "Use the whole drive")}
            onPick={(subpath) => setSource({ kind: "drive", uuid: drive.uuid, label: drive.label ?? "", fstype: drive.fstype, subpath })}
          />
          <button type="button" onClick={() => setDrive(null)} className="text-xs font-medium text-muted hover:text-fg">
            Pick another drive
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {error && <p className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger ring-1 ring-danger/30">{error}</p>}
          {!drives && !error && (
            <div className="grid place-items-center py-10 text-muted">
              <Loader2 className="size-5 animate-spin" />
            </div>
          )}
          {drives?.map((d) => (
            <button key={d.uuid} type="button" onClick={() => setDrive(d)} className="flex w-full items-center gap-3 rounded-xl bg-surface-2 px-3 py-2.5 text-left ring-1 ring-line transition-colors hover:ring-line-strong">
              <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface-3 text-muted">{d.removable ? <Usb className="size-4" /> : <HardDrive className="size-4" />}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{name(d)}</span>
                <span className="block truncate text-xs text-muted">
                  {[!!d.size && formatBytes(d.size), d.fstype, d.model && d.model !== name(d) && d.model, d.mountpoint ? `at ${d.mountpoint}` : "not mounted"].filter(Boolean).join(" · ")}
                </span>
              </span>
              <ChevronRight className="size-4 text-faint" />
            </button>
          ))}
          {drives && !drives.length && <p className="rounded-xl border border-dashed border-line-strong px-3 py-6 text-center text-sm text-muted">No drives to pick. Plug one in, then open this again.</p>}
        </div>
      )}
    </Modal>
  );
}
