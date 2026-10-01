import { describe, expect, it } from "vitest";
import {
  GITHUB_URL_RE,
  MOUNT_RE,
  cleanDraft,
  cleanSource,
  findProject,
  freeMountName,
  githubUrl,
  projectForRepo,
  repoFullName,
  repoName,
  repoToDraft,
  reposToProjects,
  sameRepo,
  sourceLabel,
  toMountName,
  toProjectDoc,
  validateProject,
  type Project,
  type ProjectDraft,
} from "./projects";

const NOTES = "https://github.com/HungGod/Notes";
const draft = (p: Partial<ProjectDraft> = {}): ProjectDraft => ({ name: "Notes", mountName: "Notes", source: { kind: "git", url: NOTES }, ...p });

const project = (id: string, p: Partial<Project> = {}): Project => ({
  id,
  name: id,
  mountName: id,
  source: { kind: "git", url: `https://github.com/HungGod/${id}` },
  setup: "",
  deleted: false,
  createdAt: 1,
  updatedAt: 1,
  ...p,
});

describe("validateProject", () => {
  it("accepts what wadd accepts", () => {
    expect(validateProject(draft())).toEqual([]);
    expect(validateProject(draft({ source: { kind: "git", url: "https://github.com/HungGod/Writing.git", ref: "main" } }))).toEqual([]);
    expect(validateProject(draft({ source: { kind: "git", url: "https://github.com/some-org/my.repo_2" } }))).toEqual([]);
    expect(validateProject(draft({ mountName: "my_notes.v2-x" }))).toEqual([]);
  });

  it("only takes GitHub https URLs", () => {
    for (const url of [
      "",
      "git@github.com:HungGod/Writing.git",
      "http://github.com/a/b",
      "https://gitlab.com/a/b",
      "https://github.com/a",
      "https://github.com/a/b/c",
      "https://github.com/a/b?x=1",
      "https://github.com.evil.io/a/b",
    ]) {
      expect(GITHUB_URL_RE.test(url)).toBe(false);
      expect(validateProject(draft({ source: { kind: "git", url } }))).toHaveLength(1);
    }
  });

  it("rejects bad names, folder names, kinds and refs", () => {
    expect(validateProject(draft({ name: "  " }))).toHaveLength(1);
    for (const m of ["", ".", "..", "has space", "a/b", "x".repeat(65)]) expect(validateProject(draft({ mountName: m }))).toHaveLength(1);
    expect(validateProject(draft({ source: { kind: "git", url: NOTES, ref: "--upload-pack=x" } }))).toHaveLength(1);
    expect(validateProject(draft({ source: { kind: "git", url: NOTES, ref: "a..b" } }))).toHaveLength(1);
    expect(validateProject(draft({ source: { kind: "empty" } as unknown as ProjectDraft["source"] }))).toHaveLength(1);
  });

  it("takes a folder by its full path, and a drive by uuid with a folder inside it", () => {
    const folder = (path: string): ProjectDraft["source"] => ({ kind: "folder", machineId: "m1", machineName: "Surface", path });
    const drive = (uuid: string, subpath: string): ProjectDraft["source"] => ({ kind: "drive", uuid, label: "Photos", fstype: "ext4", subpath });
    expect(validateProject(draft({ source: folder("/var/home/wad/Notes") }))).toEqual([]);
    expect(validateProject(draft({ source: folder("Notes") }))).toHaveLength(1);
    expect(validateProject(draft({ source: folder("") }))).toHaveLength(1);
    expect(validateProject(draft({ source: drive("1234-ABCD", "") }))).toEqual([]);
    expect(validateProject(draft({ source: drive("0f6e7c1a-58b2-4c1e-9f0a-6d2a1b3c4d5e", "Pictures/2026") }))).toEqual([]);
    expect(validateProject(draft({ source: drive("x", "") }))).toHaveLength(1);
    expect(validateProject(draft({ source: drive("1234-ABCD", "../etc") }))).toHaveLength(1);
    expect(validateProject(draft({ source: drive("1234-ABCD", "/abs") }))).toHaveLength(1);
  });
});

describe("names and URLs", () => {
  it("takes a repo's name from its url", () => {
    expect(repoName("https://github.com/HungGod/KaleBrowser.git")).toBe("KaleBrowser");
    expect(repoName("git@github.com:HungGod/Writing.git")).toBe("Writing");
    expect(repoName("https://github.com/a/b/")).toBe("b");
  });

  it("writes GitHub URLs the one way, and knows the same repo", () => {
    expect(githubUrl("git@github.com:HungGod/Writing.git")).toBe("https://github.com/HungGod/Writing.git");
    expect(githubUrl("ssh://git@github.com/HungGod/Writing")).toBe("https://github.com/HungGod/Writing");
    expect(githubUrl(" https://github.com/a/b/ ")).toBe("https://github.com/a/b");
    expect(githubUrl("https://gitlab.com/a/b")).toBeNull();
    expect(sameRepo("https://github.com/HungGod/Writing.git", "https://github.com/hunggod/writing")).toBe(true);
    expect(sameRepo("git@github.com:HungGod/Writing.git", "https://github.com/HungGod/Writing")).toBe(true);
    expect(sameRepo("https://github.com/a/b", "https://github.com/a/c")).toBe(false);
  });

  it("names a repo by owner/name", () => {
    expect(repoFullName("https://github.com/HungGod/Writing.git")).toBe("HungGod/Writing");
    expect(repoFullName("https://github.com/HungGod/my.repo")).toBe("HungGod/my.repo");
    expect(repoFullName("https://example.com/x")).toBe("https://example.com/x");
  });

  it("finds a folder name nobody uses", () => {
    const taken = [{ mountName: "Notes", deleted: false }, { mountName: "Notes-2", deleted: false }, { mountName: "Old", deleted: true }];
    expect(freeMountName(taken, "Notes")).toBe("Notes-3");
    expect(freeMountName(taken, "Old")).toBe("Old");
    expect(freeMountName([], "my notes")).toBe("my-notes");
  });

  it("makes a valid folder name out of anything", () => {
    for (const s of ["My notes!", "..", "ünïcødé", "a".repeat(100), ""]) expect(toMountName(s)).toMatch(MOUNT_RE);
    expect(toMountName("My notes")).toBe("My-notes");
  });

  it("cleans a draft for the stores", () => {
    expect(cleanDraft(draft({ name: " Notes ", source: { kind: "git", url: ` ${NOTES} `, ref: " " } }))).toEqual({
      name: "Notes",
      mountName: "Notes",
      source: { kind: "git", url: NOTES },
      setup: "",
    });
  });
});

describe("sources", () => {
  it("cleans each kind down to its fields", () => {
    expect(cleanSource({ kind: "drive", uuid: "1234-ABCD", label: "Photos", fstype: "exfat", subpath: "/Pictures/" })).toEqual({ kind: "drive", uuid: "1234-ABCD", label: "Photos", fstype: "exfat", subpath: "Pictures" });
    expect(cleanSource({ kind: "folder", machineId: "m1", machineName: "Surface", path: " /srv/x " })).toEqual({ kind: "folder", machineId: "m1", machineName: "Surface", path: "/srv/x" });
  });

  it("says where each comes from", () => {
    expect(sourceLabel({ kind: "git", url: "https://github.com/HungGod/Notes.git" })).toBe("HungGod/Notes");
    expect(sourceLabel({ kind: "folder", machineId: "m1", machineName: "Surface", path: "/x" })).toBe("Folder on Surface");
    expect(sourceLabel({ kind: "drive", uuid: "1234-ABCD", label: "", fstype: "exfat", subpath: "" })).toBe("Drive 1234-ABCD");
  });
});

describe("repoToDraft", () => {
  it("names the project and its folder after the repo", () => {
    expect(repoToDraft({ name: "my notes.v2", url: "https://github.com/you/my-notes.v2" })).toEqual({
      name: "my notes.v2",
      mountName: "my-notes.v2",
      source: { kind: "git", url: "https://github.com/you/my-notes.v2" },
      setup: "",
    });
    expect(validateProject(repoToDraft({ name: "..", url: "https://github.com/you/.." }))).toHaveLength(0);
  });
});

describe("toProjectDoc", () => {
  const ms = (t: unknown) => (typeof t === "number" ? t : 0);

  it("reads a GitHub project as it is", () => {
    const p = toProjectDoc("p1", { name: "Notes", mountName: "Notes", source: { kind: "git", url: NOTES, ref: "main" }, setup: "make", updatedAt: 5 }, ms);
    expect(p).toEqual({ id: "p1", name: "Notes", mountName: "Notes", source: { kind: "git", url: NOTES, ref: "main" }, setup: "make", deleted: false, createdAt: 0, updatedAt: 5 });
  });

  it("reads folders and drives", () => {
    const folder = { kind: "folder", machineId: "m1", machineName: "Surface", path: "/var/home/wad/Notes" };
    const drive = { kind: "drive", uuid: "1234-ABCD", label: "Photos", fstype: "exfat", subpath: "" };
    expect(toProjectDoc("f", { name: "Notes", mountName: "Notes", source: folder }, ms).source).toEqual(folder);
    expect(toProjectDoc("d", { name: "Photos", mountName: "Photos", source: drive }, ms)).not.toHaveProperty("legacy");
  });

  it("marks one it doesn't know as legacy, and drops the Syncthing fields", () => {
    for (const source of [{ kind: "empty" }, { kind: "local" }, { kind: "git", url: "git@gitlab.com:a/b.git" }, { kind: "folder", path: "rel" }, undefined]) {
      const p = toProjectDoc("p2", { name: "Old", mountName: "Old", source, holders: {}, ignore: [], folderId: "wad-p2" }, ms);
      expect(p.legacy).toBe(true);
      expect(Object.keys(p)).not.toContain("holders");
    }
    expect(toProjectDoc("p3", { name: "N", mountName: "N", source: { kind: "git", url: NOTES }, legacy: true }, ms).legacy).toBe(true);
  });
});

describe("reposToProjects", () => {
  it("turns legacy repos into GitHub projects: folder as name and mount, postClone as setup, one per repo", () => {
    const got = reposToProjects([
      { url: "https://github.com/HungGod/WadCreator.git", dest: "WadCreator", postClone: "npm install" },
      { url: "git@github.com:HungGod/Writing.git", dest: "" },
      { url: "https://github.com/HungGod/WadCreator", dest: "Again" },
      { url: "https://gitlab.com/someone/elsewhere.git", dest: "Elsewhere" },
    ]);
    expect(got).toEqual([
      { name: "WadCreator", mountName: "WadCreator", source: { kind: "git", url: "https://github.com/HungGod/WadCreator.git" }, setup: "npm install" },
      { name: "Writing", mountName: "Writing", source: { kind: "git", url: "https://github.com/HungGod/Writing.git" }, setup: "" },
    ]);
    for (const p of got) expect(validateProject(p)).toEqual([]);
  });

  it("keeps folder names apart", () => {
    const got = reposToProjects([
      { url: "https://github.com/a/x.git", dest: "Code" },
      { url: "https://github.com/b/x.git", dest: "Code" },
    ]);
    expect(got.map((p) => p.mountName)).toEqual(["Code", "Code-2"]);
  });
});

describe("findProject", () => {
  const all = [
    project("a", { mountName: "Writing", source: { kind: "git", url: "https://github.com/HungGod/Writing.git" } }),
    project("b", { mountName: "Notes" }),
    project("c", { mountName: "Old", deleted: true }),
    project("d", { mountName: "Legacy", legacy: true, source: { kind: "folder", machineId: "", machineName: "", path: "" } }),
  ];

  it("matches by repository, then by folder name, never a deleted one", () => {
    expect(findProject(all, draft({ mountName: "Vault", source: { kind: "git", url: "https://github.com/hunggod/writing" } }))?.id).toBe("a");
    expect(findProject(all, draft({ mountName: "Notes", source: { kind: "git", url: "https://github.com/x/y" } }))?.id).toBe("b");
    expect(findProject(all, draft({ mountName: "Old", source: { kind: "git", url: "https://github.com/x/y" } }))).toBeUndefined();
  });

  it("marks repos you've added already", () => {
    expect(projectForRepo(all, { url: "https://github.com/HungGod/Writing" })?.id).toBe("a");
    expect(projectForRepo(all, { url: "https://github.com/HungGod/c" })).toBeUndefined();
    expect(projectForRepo(all, { url: "" })).toBeUndefined();
  });
});
