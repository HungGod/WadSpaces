// Projects: what wadspaces start with in ~/Desktop. Nothing is mounted: your
// GitHub repositories are cloned into the wadspaces whose Customization has
// them (and fast-forwarded at each start when that's safe), and files from a
// machine are copied in once. Here: your repositories (and which wadspaces
// clone each), a new one, and the copies wadspaces take in. They're added to
// a wadspace in the Builder, in its Customization.
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { FolderGit2, HardDriveDownload, Lock, Plus, RefreshCw } from "lucide-react";
import { Page } from "@/components/Page";
import { GITHUB_NEW, GithubTokenCallout, NewRepoDialog, OutLink } from "@/components/GithubRepos";
import { Badge, Button, EmptyState, PageHeader } from "@/components/ui";
import { backend } from "@/data";
import type { GithubRepoList } from "@/data/backend";
import { wadspaceName } from "@/data/layers";
import type { StackProject, Wadspace } from "@core/layers";
import { timeAgo } from "@/lib/format";
import { alive, useApp } from "@/lib/store";

const sizeOf = (bytes = 0) => (bytes > 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : bytes > 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`);

type Copy = Extract<StackProject, { kind: "copy" }>;

export default function ProjectsPage() {
  const wadspaces = useApp((s) => s.wadspaces);
  const navigate = useNavigate();
  const [list, setList] = useState<GithubRepoList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setList(await backend.listGithubRepos());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
    return backend.subscribe((t) => t === "github" && void load());
  }, [load]);

  // Who has what: each wadspace's projects.
  const stacks = alive(wadspaces).filter((w) => w.customization);
  const cloning = (repo: string) => stacks.filter((w) => w.customization!.projects.some((p) => p.kind === "github" && p.repo.toLowerCase() === repo.toLowerCase()));
  const copies = new Map<string, { p: Copy; in: Wadspace[] }>();
  for (const w of stacks) for (const p of w.customization!.projects) if (p.kind === "copy") copies.set(p.id, { p, in: [...(copies.get(p.id)?.in ?? []), w] });
  const chips = (ws: Wadspace[]) =>
    ws.map((w) => (
      <button key={w.id} type="button" onClick={() => navigate(`/builder?stack=${encodeURIComponent(w.id)}`)} title="Open it in the Builder">
        <Badge tone="accent-2">In {wadspaceName(w)}</Badge>
      </button>
    ));
  const refresh = async () => {
    await backend.refreshGithubRepos?.().catch(() => 0);
    await load();
  };

  return (
    <Page>
      <PageHeader
        title="Projects"
        subtitle="What your wadspaces start with in ~/Desktop. Your GitHub repositories are cloned into them and files from a machine are copied in: nothing is mounted. Add them to a wadspace in the Builder, in its Customization."
      >
        <Button variant="ghost" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw className="size-4" /> Refresh
        </Button>
        <Button variant="primary" onClick={() => (backend.target === "online" ? window.open(GITHUB_NEW, "_blank", "noreferrer") : setCreating(true))}>
          <Plus className="size-4" /> New repository
        </Button>
      </PageHeader>

      <h2 className="mb-3 font-display text-base font-semibold">GitHub repositories{list?.login ? ` (${list.login})` : ""}</h2>
      {list?.missing ? (
        <GithubTokenCallout missing={list.missing} onRetry={() => void load()} busy={loading} />
      ) : error ? (
        <p className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger ring-1 ring-danger/30">{error}</p>
      ) : !list ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : !list.repos.length ? (
        <EmptyState icon={<FolderGit2 className="size-6" />} title="No repositories yet" body="Make one, then clone it into a wadspace from its Customization in the Builder." />
      ) : (
        <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
          {list.repos.map((r) => (
            <div key={r.fullName} className="flex flex-col rounded-2xl border border-line bg-surface/70 p-4">
              <div className="flex items-start gap-3">
                <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent">
                  <FolderGit2 className="size-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <OutLink href={r.url} className="truncate font-medium">
                      {r.fullName}
                    </OutLink>
                    {r.private && <Lock className="size-3.5 shrink-0 text-faint" aria-label="Private" />}
                  </div>
                  <div className="truncate text-xs text-muted">{r.description || (r.pushedAt ? `Pushed ${timeAgo(r.pushedAt)}` : "")}</div>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">{chips(cloning(r.fullName))}</div>
            </div>
          ))}
        </div>
      )}

      <h2 className="mb-3 mt-10 font-display text-base font-semibold">Copied in</h2>
      {copies.size ? (
        <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
          {[...copies.values()].map(({ p, in: ws }) => (
            <div key={p.id} className="flex flex-col rounded-2xl border border-line bg-surface/70 p-4">
              <div className="flex items-start gap-3">
                <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-surface-3 text-muted">
                  <HardDriveDownload className="size-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">~/Desktop/{p.as}</div>
                  <div className="truncate text-xs text-muted">
                    {p.source.drive ? `from the drive ${p.source.drive.label || p.source.drive.uuid}` : `from ${p.source.paths.join(", ")}`}
                    {p.files ? ` · ${p.files} files, ${sizeOf(p.bytes)}` : " · copied when it first starts there"}
                  </div>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">{chips(ws)}</div>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted">No copies yet. In the Builder, a Customization&apos;s Projects copies a folder or files in from the machine.</p>
      )}

      <NewRepoDialog open={creating} onClose={() => setCreating(false)} onCreated={() => void load()} />
    </Page>
  );
}
