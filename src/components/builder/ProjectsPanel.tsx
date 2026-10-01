import { useState } from "react";
import { Check, Folder, FolderGit2, HardDrive, TriangleAlert, X } from "lucide-react";
import clsx from "clsx";
import { backend } from "@/data";
import type { Project } from "@core/projects";
import { useApp } from "@/lib/store";
import { AddFromGithub } from "../GithubRepos";
import { AddDriveDialog, AddFolderDialog } from "../HostFolders";
import { SourceIcon } from "../ProjectDialog";

/** Builder step 2: the projects a wadspace opens with unless you pick others. */
export function ProjectsPanel({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
  const projects = useApp((s) => s.projects);
  const [adding, setAdding] = useState<"github" | "folder" | "drive" | null>(null);
  const offline = backend.target === "offline";

  if (!backend.caps.projects) {
    return (
      <div className="p-4">
        <div className="rounded-2xl border border-dashed border-line-strong p-5 text-center">
          <Folder className="mx-auto size-6 text-accent" />
          <div className="mt-2 text-sm font-semibold">Projects need a system update</div>
          <p className="mt-1 text-xs text-muted">This machine's wadd predates projects. Update it with a stick update, then pick the folders this wadspace opens with.</p>
        </div>
      </div>
    );
  }

  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  const missing = value.filter((id) => !projects.some((p) => p.id === id));
  const picked = projects.filter((p) => value.includes(p.id));
  const clash = picked.find((p, i) => picked.findIndex((q) => q.mountName === p.mountName) !== i);
  // A new project is one of this wadspace's defaults straight away.
  const added = (p: Project) => onChange([...value.filter((x) => x !== p.id), p.id]);
  const addButton = "flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-muted hover:bg-surface-2 hover:text-fg";

  return (
    <div className="space-y-4 p-4">
      <p className="text-xs leading-relaxed text-muted">
        Projects are your work (GitHub repositories, folders, drives), opened on the wadspace's Desktop. Tick the ones it opens with; you can pick others each time you open it,
        and the files stay put when it stops.
      </p>

      <div className="space-y-1.5">
        {projects.map((p) => {
          const on = value.includes(p.id);
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => toggle(p.id)}
              aria-pressed={on}
              className={clsx("flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left ring-1 transition-colors", on ? "bg-accent-soft ring-accent" : "bg-surface-2 ring-line hover:ring-line-strong")}
            >
              <span className={clsx("grid size-8 shrink-0 place-items-center rounded-lg", on ? "bg-accent text-accent-fg" : "bg-surface-3 text-muted")}>
                {on ? <Check className="size-4" strokeWidth={3} /> : <SourceIcon project={p} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{p.name}</span>
                <span className="block truncate font-mono text-[11px] text-muted">~/Desktop/{p.mountName}</span>
              </span>
            </button>
          );
        })}
        {missing.map((id) => (
          <div key={id} className="flex items-center gap-3 rounded-xl bg-surface-2 px-2.5 py-2 text-sm text-muted ring-1 ring-line">
            <TriangleAlert className="size-4 shrink-0 text-accent-2" />
            <span className="flex-1">A project that's been deleted</span>
            <button type="button" onClick={() => onChange(value.filter((x) => x !== id))} className="grid size-6 place-items-center rounded-md text-faint hover:bg-surface-3 hover:text-fg" aria-label="Remove">
              <X className="size-3.5" />
            </button>
          </div>
        ))}
        {!projects.length && !missing.length && <p className="rounded-xl border border-dashed border-line-strong px-3 py-4 text-center text-xs text-muted">No projects yet. Add one of your repositories below.</p>}
      </div>

      {clash && <p className="text-xs text-accent-2">Two of these open as ~/Desktop/{clash.mountName}; rename one on the Projects page.</p>}

      <div className="flex flex-wrap items-center gap-1">
        <button type="button" onClick={() => setAdding("github")} className={addButton}>
          <FolderGit2 className="size-3.5" /> Add from GitHub
        </button>
        {offline && (
          <>
            <button type="button" onClick={() => setAdding("folder")} className={addButton}>
              <Folder className="size-3.5" /> Folder
            </button>
            <button type="button" onClick={() => setAdding("drive")} className={addButton}>
              <HardDrive className="size-3.5" /> Drive
            </button>
          </>
        )}
      </div>
      <AddFromGithub open={adding === "github"} onClose={() => setAdding(null)} onAdded={added} />
      {offline && (
        <>
          <AddFolderDialog open={adding === "folder"} onClose={() => setAdding(null)} onAdded={added} />
          <AddDriveDialog open={adding === "drive"} onClose={() => setAdding(null)} onAdded={added} />
        </>
      )}

      {/* Not a link: leaving the Builder would drop unsaved work. */}
      <p className="text-[11px] text-faint">Editing and deleting are on the Projects page.</p>
    </div>
  );
}
