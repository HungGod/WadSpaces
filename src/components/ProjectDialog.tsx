import { useEffect, useState } from "react";
import { Folder, FolderGit2, FolderX, Globe, HardDrive, Loader2, Lock } from "lucide-react";
import { backend } from "@/data";
import {
  baseName,
  cleanDraft,
  freeMountName,
  sourceLabel,
  sourcePath,
  validateProject,
  type GithubRepo,
  type Project,
  type ProjectDraft,
  type ProjectSource,
} from "@core/projects";
import { useApp } from "@/lib/store";
import { Badge, Button, Input, Label, Modal } from "./ui";

/** A project's kind at a glance: a GitHub repository, a folder, or a drive. */
export function SourceIcon({ project, className = "size-4" }: { project: Pick<Project, "source" | "legacy">; className?: string }) {
  if (project.legacy) return <FolderX className={className} />;
  if (project.source.kind === "drive") return <HardDrive className={className} />;
  if (project.source.kind === "folder") return <Folder className={className} />;
  return <FolderGit2 className={className} />;
}

/** Edit a project: its name, folder, setup command, and a repository's branch. Where it comes from stays. */
export function ProjectDialog({ project, onClose }: { project: Project | null; onClose: () => void }) {
  const subtitle =
    project?.source.kind === "folder"
      ? "A folder on one machine, opened where it is."
      : project?.source.kind === "drive"
        ? "A drive, opened on whichever machine it's plugged into."
        : "A GitHub repository, cloned onto the machines that open it.";
  return (
    <Modal open={!!project} onClose={onClose} width={520} title={project && `Edit ${project.name}`} subtitle={subtitle}>
      {project && <ProjectForm key={project.id} project={project} onCancel={onClose} onSaved={onClose} />}
    </Modal>
  );
}

/** A new project's name, from where it comes from. */
function defaultName(source: ProjectSource, repo?: GithubRepo): string {
  if (repo) return repo.name;
  if (source.kind === "folder") return baseName(source.path);
  if (source.kind === "drive") return (source.subpath && baseName(source.subpath)) || source.label || "Drive";
  return "";
}

/**
 * The small form for a project: one you're adding (a repository you picked,
 * a folder or a drive), or one you have (editing it). Name and folder name
 * start from where it comes from.
 */
export function ProjectForm({
  project,
  repo,
  source: newSource,
  onCancel,
  onSaved,
  cancelLabel = "Cancel",
}: {
  project?: Project;
  /** Adding this repository. */
  repo?: GithubRepo;
  /** Adding a folder or drive. */
  source?: ProjectSource;
  onCancel: () => void;
  onSaved: (p: Project) => void;
  cancelLabel?: string;
}) {
  const projects = useApp((s) => s.projects);
  const toast = useApp((s) => s.toast);
  const loadProjects = useApp((s) => s.loadProjects);
  const source: ProjectSource = project?.source ?? newSource ?? { kind: "git", url: repo?.url ?? "" };
  const git = source.kind === "git";
  const [name, setName] = useState(project?.name ?? defaultName(source, repo));
  const [mount, setMount] = useState(project?.mountName ?? freeMountName(projects, defaultName(source, repo)));
  const [ref, setRef] = useState(git ? (source.ref ?? "") : "");
  const [setup, setSetup] = useState(project?.setup ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setError(null), [name, mount, ref, setup]);

  const draft: ProjectDraft = cleanDraft({
    ...(project && { id: project.id }),
    name,
    mountName: mount,
    source: git ? { kind: "git", url: source.url, ...(ref.trim() && { ref }) } : source,
    setup,
  });
  const problems = validateProject(draft);
  const clash = projects.find((p) => p.id !== project?.id && p.mountName === draft.mountName);
  const where = sourcePath(source);

  const save = async () => {
    if (problems.length) return setError(problems[0]);
    setSaving(true);
    setError(null);
    try {
      const p = await backend.saveProject(draft);
      await loadProjects().catch(() => {});
      toast({ title: project ? "Project saved" : "Project added", body: p.name, tone: "success" });
      onSaved(p);
    } catch (e) {
      // e.g. 422: wadd won't use that path.
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 rounded-xl bg-surface-2 px-3 py-2.5 ring-1 ring-line">
        <span className="shrink-0 text-accent">
          <SourceIcon project={{ source }} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-xs" title={git ? source.url : (where ?? undefined)}>
            {repo?.fullName ?? sourceLabel(source)}
          </span>
          {where && <span className="block truncate font-mono text-[11px] text-muted">{where}</span>}
        </span>
        {repo && (
          <Badge>
            {repo.private ? <Lock className="size-3" /> : <Globe className="size-3" />} {repo.private ? "private" : "public"}
          </Badge>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label>Name</Label>
          <Input autoFocus placeholder="My project" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <Label hint="on the Desktop">Folder</Label>
          <Input className="font-mono text-xs" placeholder="Project" value={mount} onChange={(e) => setMount(e.target.value)} />
        </div>
      </div>
      <div className={git ? "grid grid-cols-[1fr_140px] gap-2" : ""}>
        <div>
          <Label hint="runs once in the wadspace">Setup command</Label>
          <Input className="font-mono text-xs" placeholder="e.g. npm install" value={setup} onChange={(e) => setSetup(e.target.value)} />
        </div>
        {git && (
          <div>
            <Label hint="optional">Branch or tag</Label>
            <Input className="font-mono text-xs" placeholder={repo?.defaultBranch ?? "default"} value={ref} onChange={(e) => setRef(e.target.value)} />
          </div>
        )}
      </div>
      <p className="text-xs text-muted">
        {source.kind === "folder"
          ? "Wadspaces open it where it is, on that machine only. Nothing is copied."
          : source.kind === "drive"
            ? "Wadspaces open it on whichever machine the drive is plugged into. Nothing is copied."
            : project
              ? "Machines that have it cloned keep their clone; a new branch applies to new clones."
              : "Each machine clones it the first time a wadspace opens it there, and pulls when it opens again if you've nothing uncommitted. You commit and push yourself."}
      </p>
      {clash && <p className="text-xs text-accent-2">"{clash.name}" already opens as ~/Desktop/{clash.mountName}. Pick another folder name.</p>}
      {error && <p className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger ring-1 ring-danger/30">{error}</p>}
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button variant="primary" onClick={save} disabled={saving || !draft.name || !draft.mountName || !!clash}>
          {saving && <Loader2 className="size-4 animate-spin" />} {project ? "Save" : "Add project"}
        </Button>
      </div>
    </div>
  );
}
