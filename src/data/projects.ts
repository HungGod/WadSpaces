// Projects in the data layer, the same for both backends: finding (or
// creating) the user's projects that a preset or an old repos list stands
// for, and moving stored wadspaces and drafts from repos to projects.
//
// Project ids belong to each user, so neither a preset nor a repos list can
// name them: they name drafts (core/projects.ts), matched to the user's own
// projects by git URL, then by folder name.
import type { Advanced } from "@core/model";
import { findProject, reposToProjects, type Project, type ProjectDraft, type RepoEntry } from "@core/projects";

/** The part of a backend this needs. */
export interface ProjectOps {
  listProjects(): Promise<Project[]>;
  saveProject(p: ProjectDraft): Promise<Project>;
}

// One at a time: two pages loading at once mustn't both create "Writing".
let queue: Promise<unknown> = Promise.resolve();

/** The ids of the user's projects for these drafts, creating the missing ones. */
export function ensureProjects(ops: ProjectOps, drafts: ProjectDraft[]): Promise<string[]> {
  const run = queue.then(async () => {
    let all = await ops.listProjects();
    const ids: string[] = [];
    for (const d of drafts) {
      let p = findProject(all, d);
      if (!p) {
        p = await ops.saveProject(d);
        all = [...all, p];
      }
      if (!ids.includes(p.id)) ids.push(p.id);
    }
    return ids;
  });
  queue = run.catch(() => {});
  return run;
}

/** The ids of the user's projects for these drafts that exist already (no creating). */
export function knownProjectIds(projects: Project[], drafts: ProjectDraft[]): string[] {
  return [...new Set(drafts.flatMap((d) => findProject(projects, d)?.id ?? []))];
}

/** advanced as stored before projects: a repos list, and no projects. */
export type StoredAdvanced = Omit<Advanced, "projects"> & { projects?: string[]; repos?: RepoEntry[] };

export const hasRepos = (adv?: StoredAdvanced | null): adv is StoredAdvanced & { repos: RepoEntry[] } => !!adv && "repos" in adv;

/** An old wadspace's repos as its default projects (created where missing),
 *  after any it has already; the repos list is dropped. */
export async function migrateRepos(ops: ProjectOps, adv: StoredAdvanced): Promise<Advanced> {
  const { repos, ...rest } = adv;
  const ids = repos?.length ? await ensureProjects(ops, reposToProjects(repos)) : [];
  return { ...rest, projects: [...new Set([...(rest.projects ?? []), ...ids])] };
}

/** advanced with a projects list, for documents saved before there was one. */
export function withProjects(adv: StoredAdvanced): Advanced {
  return adv.projects ? (adv as Advanced) : { ...adv, projects: [] };
}
