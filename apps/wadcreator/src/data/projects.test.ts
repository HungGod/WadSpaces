import { describe, expect, it } from "vitest";
import { defaultAdvanced } from "@core/model";
import type { Project, ProjectDraft } from "@core/projects";
import { ensureProjects, hasRepos, knownProjectIds, migrateRepos, type ProjectOps, type StoredAdvanced } from "./projects";

/** A backend's project store in memory, counting what it creates. */
function fakeOps(start: Partial<Project>[] = []): ProjectOps & { all: Project[]; created: number } {
  let n = 0;
  const mk = (p: Partial<Project>): Project => ({
    id: p.id ?? `p${++n}`,
    name: p.name ?? "x",
    mountName: p.mountName ?? p.name ?? "x",
    source: p.source ?? { kind: "git", url: `https://github.com/you/${p.name ?? "x"}` },
    setup: "",
    deleted: p.deleted ?? false,
    createdAt: 0,
    updatedAt: 0,
  });
  const ops = {
    all: start.map(mk),
    created: 0,
    async listProjects() {
      return ops.all.filter((p) => !p.deleted);
    },
    async saveProject(d: ProjectDraft) {
      const p = mk({ name: d.name, mountName: d.mountName, source: d.source });
      ops.all.push(p);
      ops.created++;
      return p;
    },
  };
  return ops;
}

const writing: ProjectDraft = { name: "Writing", mountName: "Writing", source: { kind: "git", url: "https://github.com/HungGod/Writing.git" } };

describe("ensureProjects", () => {
  it("reuses a project with the same url or folder, and makes the rest", async () => {
    const ops = fakeOps([{ id: "w", name: "Vault", mountName: "Vault", source: writing.source }, { id: "n", name: "Notes" }]);
    const ids = await ensureProjects(ops, [writing, { name: "Notes", mountName: "Notes", source: { kind: "git", url: "https://github.com/you/OtherNotes" } }, { name: "New", mountName: "New", source: { kind: "git", url: "https://github.com/you/New" } }]);
    expect(ids.slice(0, 2)).toEqual(["w", "n"]);
    expect(ops.created).toBe(1);
  });

  it("doesn't make the same project twice when asked at once", async () => {
    const ops = fakeOps();
    const [a, b] = await Promise.all([ensureProjects(ops, [writing]), ensureProjects(ops, [writing])]);
    expect(a).toEqual(b);
    expect(ops.created).toBe(1);
  });

  it("knownProjectIds only finds, never makes", () => {
    const ops = fakeOps([{ id: "w", name: "Writing" }]);
    expect(knownProjectIds(ops.all, [writing, { name: "Gone", mountName: "Gone", source: { kind: "git", url: "https://github.com/you/Gone" } }])).toEqual(["w"]);
  });
});

describe("migrateRepos", () => {
  it("turns an old repos list into default projects and drops it", async () => {
    const ops = fakeOps([{ id: "w", name: "Writing", source: writing.source }]);
    const { projects: _p, ...old } = defaultAdvanced("Etc/UTC");
    const stored: StoredAdvanced = { ...old, repos: [{ url: "https://github.com/HungGod/Writing.git", dest: "Writing" }, { url: "https://github.com/a/b.git", dest: "B", postClone: "make" }] };
    expect(hasRepos(stored)).toBe(true);
    const adv = await migrateRepos(ops, stored);
    expect("repos" in adv).toBe(false);
    expect(adv.projects).toEqual(["w", ops.all[1].id]);
    expect(ops.all[1]).toMatchObject({ name: "B", mountName: "B", source: { kind: "git", url: "https://github.com/a/b.git" } });
    expect(hasRepos(adv)).toBe(false);
  });

  it("keeps projects it already had", async () => {
    const ops = fakeOps();
    const adv = await migrateRepos(ops, { ...defaultAdvanced(), projects: ["keep"], repos: [] });
    expect(adv.projects).toEqual(["keep"]);
    expect(ops.created).toBe(0);
  });
});
