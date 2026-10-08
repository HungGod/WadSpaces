import { useCallback, useEffect, useState } from "react";
import { ArrowDown, ArrowUp, ChevronDown, Cloud, Folder, FolderGit2, GitBranch, HardDrive, MonitorCheck, MonitorX, Pencil, Plus, Trash2, TriangleAlert } from "lucide-react";
import clsx from "clsx";
import { Page } from "@/components/Page";
import { DeleteProject } from "@/components/DeleteProject";
import { ProjectDialog, SourceIcon } from "@/components/ProjectDialog";
import { AddFromGithub, GITHUB_NEW, GithubTokenCallout, NewRepoDialog, NewRepoOnlineNote, OutLink } from "@/components/GithubRepos";
import { AddDriveDialog, AddFolderDialog } from "@/components/HostFolders";
import { Badge, Button, Dropdown, EmptyState, IconButton, PageHeader } from "@/components/ui";
import { backend } from "@/data";
import type { GithubStatus } from "@/data/backend";
import { sourceLabel, sourcePath, type Project, type ProjectStatus } from "@core/projects";
import { useApp } from "@/lib/store";
import { hasLocal } from "@/lib/machine";

type Adding = "github" | "github-new" | "folder" | "drive";

/** The user's projects: GitHub repositories, folders and drives that wadspaces open on their Desktop. */
export default function ProjectsPage() {
  const projects = useApp((s) => s.projects);
  const wadspaces = useApp((s) => s.wadspaces);
  const machines = useApp((s) => s.machines);
  const toast = useApp((s) => s.toast);
  const [editing, setEditing] = useState<Project | null>(null);
  const [deleting, setDeleting] = useState<Project | null>(null);
  const [adding, setAdding] = useState<Adding | null>(null);
  const [creating, setCreating] = useState(false);
  const [status, setStatus] = useState<Record<string, ProjectStatus | null>>({});
  const [github, setGithub] = useState<GithubStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const offline = hasLocal;

  // Offline, each project's folder on this machine (refreshed as wadspaces start and stop).
  useEffect(() => {
    if (!offline || !backend.caps.projects) return;
    let off = false;
    Promise.all(projects.map(async (p) => [p.id, await backend.projectStatus(p.id).catch(() => null)] as const)).then((rows) => !off && setStatus(Object.fromEntries(rows)));
    return () => {
      off = true;
    };
  }, [offline, projects, machines]);

  // Is there a token (offline), or a list your machines shared (online).
  const checkGithub = useCallback(async () => {
    if (!backend.caps.projects) return;
    setChecking(true);
    try {
      setGithub(await backend.githubStatus());
    } catch {
      setGithub(null);
    } finally {
      setChecking(false);
    }
  }, []);
  useEffect(() => {
    checkGithub();
    return backend.subscribe((t) => t === "github" && checkGithub());
  }, [checkGithub]);

  const name = (wsId: string) => wadspaces.find((w) => w.id === wsId)?.name ?? wsId;

  const newRepo = () => {
    if (offline) return setCreating(true);
    // Online there's no token here: GitHub makes it, a machine lists it, you pick it.
    window.open(GITHUB_NEW, "_blank", "noreferrer");
    setAdding("github-new");
  };
  /** Folders and drives are picked on the machine they're on. */
  const onMachine = () => toast({ title: "Add it on that machine", body: "Folders and drives are picked in WadSpaces on the machine they're on (Projects → Add)." });

  return (
    <Page>
      <PageHeader
        title="Projects"
        subtitle={
          offline
            ? "Your work: GitHub repositories, folders and drives. A wadspace opens the ones you pick on its Desktop, and the files stay put when it stops."
            : "Your work: GitHub repositories, folders and drives. A wadspace opens the ones you pick on its Desktop."
        }
      >
        {backend.caps.projects && (
          <>
            <Button onClick={newRepo}>
              <Plus className="size-4" /> New repo
            </Button>
            <Dropdown
              trigger={(open) => (
                <Button variant="primary">
                  <Plus className="size-4" /> Add <ChevronDown className={clsx("size-4 transition-transform", open && "rotate-180")} />
                </Button>
              )}
              items={[
                { label: "From GitHub", icon: <FolderGit2 />, onClick: () => setAdding("github") },
                { label: offline ? "Folder on this machine" : "Folder on a machine", icon: <Folder />, onClick: () => (offline ? setAdding("folder") : onMachine()) },
                { label: "Drive", icon: <HardDrive />, onClick: () => (offline ? setAdding("drive") : onMachine()) },
              ]}
            />
          </>
        )}
      </PageHeader>

      {!offline && (
        <p className="mb-6 flex items-start gap-2.5 rounded-2xl bg-surface-2/60 px-4 py-3 text-sm text-muted ring-1 ring-line">
          <Cloud className="mt-0.5 size-4 shrink-0 text-accent" />
          The files are on your machines and GitHub, not here. A machine clones a repository the first time a wadspace opens it there, and pulls when it opens it again if
          nothing's uncommitted or unpushed. A folder opens on its machine, a drive wherever it's plugged in.
        </p>
      )}

      {backend.caps.projects && github && !github.token && (
        <div className="mb-6">
          <GithubTokenCallout missing={offline ? "token" : "shared"} onRetry={offline ? checkGithub : () => setAdding("github")} busy={checking} />
        </div>
      )}
      {backend.caps.projects && github?.token && github.error && (
        <p className="mb-6 rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger ring-1 ring-danger/30">GitHub: {github.error}</p>
      )}

      {!backend.caps.projects ? (
        <EmptyState
          icon={<FolderGit2 className="size-6" />}
          title="Not on this machine yet"
          body="This machine's wadd predates projects. Update the system (a stick update) to use them."
        />
      ) : !projects.length ? (
        <EmptyState
          icon={<FolderGit2 className="size-6" />}
          title="No projects yet"
          body="Add one of your GitHub repositories (or make a new one), a folder or a drive. Then pick it when you open a wadspace, or as one of its defaults in the Builder."
          action={
            <Button variant="primary" onClick={() => setAdding("github")}>
              <FolderGit2 className="size-4" /> Add from GitHub
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
          {projects.map((p) => {
            const st = status[p.id];
            const defaults = wadspaces.filter((w) => w.advanced.projects?.includes(p.id));
            const where = sourcePath(p.source);
            return (
              <div key={p.id} className="flex flex-col rounded-2xl border border-line bg-surface/70 p-4 transition-colors hover:border-line-strong">
                <div className="flex items-start gap-3">
                  <span className={clsx("grid size-10 shrink-0 place-items-center rounded-xl", p.legacy ? "bg-surface-3 text-faint" : "bg-accent-soft text-accent")}>
                    <SourceIcon project={p} className="size-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-display text-[15px] font-semibold">{p.name}</div>
                    <div className="truncate font-mono text-xs text-muted">~/Desktop/{p.mountName}</div>
                  </div>
                  {!p.legacy && (
                    <IconButton label="Edit" onClick={() => setEditing(p)}>
                      <Pencil className="size-4" />
                    </IconButton>
                  )}
                  <IconButton label="Delete" onClick={() => setDeleting(p)}>
                    <Trash2 className="size-4" />
                  </IconButton>
                </div>
                <div className="mt-3 space-y-1 text-xs text-muted">
                  {p.legacy ? (
                    <div className="flex items-start gap-1.5 text-accent-2">
                      <TriangleAlert className="mt-px size-3.5 shrink-0" />
                      <span>Not a GitHub repo: an empty folder from before projects were repositories. Wadspaces still open it where it is; push the work to a repository, add that, and delete this.</span>
                    </div>
                  ) : p.source.kind === "git" ? (
                    <div className="truncate" title={p.source.url}>
                      <OutLink href={p.source.url.replace(/\.git$/, "")} className="font-mono">
                        {sourceLabel(p.source)}
                      </OutLink>
                      {p.source.ref && <> · {p.source.ref}</>}
                    </div>
                  ) : (
                    <div className="truncate" title={where ?? undefined}>
                      {sourceLabel(p.source)} · <span className="font-mono">{where}</span>
                    </div>
                  )}
                  {p.setup && (
                    <div className="truncate">
                      Setup: <span className="font-mono">{p.setup}</span>
                    </div>
                  )}
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {offline && st && <FolderState p={p} st={st} />}
                  {offline && st?.mountedIn.map((id) => <Badge key={id}>Mounted in {name(id)}</Badge>)}
                  {defaults.map((w) => (
                    <Badge key={w.id} tone="accent-2">
                      Default for {w.name}
                    </Badge>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <ProjectDialog project={editing} onClose={() => setEditing(null)} />
      <AddFromGithub open={adding === "github" || adding === "github-new"} onClose={() => setAdding(null)} intro={adding === "github-new" ? <NewRepoOnlineNote /> : undefined} />
      {offline && (
        <>
          <NewRepoDialog open={creating} onClose={() => setCreating(false)} />
          <AddFolderDialog open={adding === "folder"} onClose={() => setAdding(null)} />
          <AddDriveDialog open={adding === "drive"} onClose={() => setAdding(null)} />
        </>
      )}
      <DeleteProject project={deleting} status={deleting ? status[deleting.id] : null} onClose={() => setDeleting(null)} />
    </Page>
  );
}

/** The project on this machine: whether it can open here, and a clone's branch and what's not in step with GitHub. */
function FolderState({ p, st }: { p: Project; st: ProjectStatus }) {
  if (!st.available) {
    return (
      <Badge>
        <MonitorX className="size-3" /> {st.reason ? `Not here: ${st.reason}` : "Not on this machine"}
      </Badge>
    );
  }
  const g = st.git;
  return (
    <>
      {!st.existsOnDisk ? (
        <Badge>
          <HardDrive className="size-3" /> {p.source.kind === "git" ? "Not cloned on this machine yet" : "Not found on this machine"}
        </Badge>
      ) : (
        !g && (
          <Badge tone="accent">
            <MonitorCheck className="size-3" /> {p.source.kind === "drive" ? "Plugged in here" : "On this machine"}
          </Badge>
        )
      )}
      {g && (
        <>
          <Badge tone="accent">
            <GitBranch className="size-3" /> {g.branch ?? "detached"}
          </Badge>
          {g.dirty && <Badge tone="accent-2">uncommitted changes</Badge>}
          {g.ahead > 0 && (
            <Badge tone="accent-2">
              <ArrowUp className="size-3" /> {g.ahead} to push
            </Badge>
          )}
          {g.behind > 0 && (
            <Badge>
              <ArrowDown className="size-3" /> {g.behind} behind
            </Badge>
          )}
          {!g.upstream && p.source.kind === "git" && <Badge>no upstream</Badge>}
        </>
      )}
    </>
  );
}
