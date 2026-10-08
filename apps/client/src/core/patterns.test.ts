// The patterns the UI and firestore.rules keep as regexes are the ones the
// core (wad-core) checks, and the feature list is in its install order.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DRIVE_UUID_RE, GITHUB_URL_RE, MOUNT_RE, PROJECT_ID_RE, REPO_NAME_RE } from "./projects";
import { FEATURES, ID_RE } from "./spec";
import { call } from "./wasm";

const SAMPLES = [
  "https://github.com/you/Notes",
  "https://github.com/you/Notes.git",
  "https://github.com/you/.git",
  "https://github.com/you/a/b",
  "https://github.com/you/",
  "https://github.com//x",
  "http://github.com/you/Notes",
  "https://github.com/y-o_u.x/N.o-t_es",
  "https://github.com/you/Nötes",
  "Notes",
  "a",
  ".",
  "..",
  "x".repeat(64),
  "x".repeat(65),
  "my-project_1.2",
  "with space",
  "1234-ABCD",
  "abc",
  "a/b",
  "-x",
  "x-",
  "UPPER",
  "",
  "ünï",
];

describe("patterns", () => {
  it.each<[string, RegExp]>([
    ["isGithubUrl", GITHUB_URL_RE],
    ["isMount", MOUNT_RE],
    ["isProjectId", PROJECT_ID_RE],
    ["isDriveUuid", DRIVE_UUID_RE],
    ["isRepoName", REPO_NAME_RE],
    ["isId", ID_RE],
  ])("%s is the regex", (fn, re) => {
    for (const s of SAMPLES) expect(call(fn, s), `${fn}(${JSON.stringify(s)})`).toBe(re.test(s));
  });

  it("firestore.rules uses the same ones", () => {
    const rules = readFileSync(new URL("../../firestore.rules", import.meta.url), "utf8");
    // The rules write `.` as `[.]` (their strings have no escapes).
    const asRules = (re: RegExp) => re.source.replace(/\\\//g, "/").replace(/\\\./g, "[.]");
    for (const re of [GITHUB_URL_RE, MOUNT_RE, PROJECT_ID_RE, DRIVE_UUID_RE, ID_RE]) expect(rules).toContain(`'${asRules(re)}'`);
  });

  it("features are in the core's install order", () => {
    expect(FEATURES.map((f) => f.id)).toEqual(call("features"));
  });
});
