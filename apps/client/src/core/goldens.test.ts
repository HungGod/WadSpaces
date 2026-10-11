// fixtures/core/goldens.json: what the core returns for the corpus in
// goldens.ts. `WRITE_GOLDENS=1 npx vitest run src/core/goldens.test.ts`
// rewrites the file from this implementation; otherwise every case is checked
// against it. The Rust core (crates/wad-core) checks the same file.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cases } from "./goldens";
import * as projects from "./projects";
import { call } from "./wasm";
import * as layers from "./layers";

const FILE = fileURLToPath(new URL("../../../../fixtures/core/goldens.json", import.meta.url));

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
/** Arguments as the functions take them: {"$bytes"} → Uint8Array. */
function revive(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(revive);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.$bytes === "string") return new Uint8Array(Buffer.from(o.$bytes, "base64"));
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, revive(x)]));
  }
  return v;
}
/** Results as JSON: Uint8Array → {"$bytes"}, undefined dropped (as JSON does). */
function plain(v: unknown): unknown {
  if (v instanceof Uint8Array) return { $bytes: b64(v) };
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, plain(x)]));
  }
  return v === undefined ? null : v;
}

type Fn = (...args: never[]) => unknown;
// The TypeScript wrappers where there are any; anything else is called in
// the core by name (Rust-only functions the corpus still checks).
const IMPL: Record<string, Fn> = {
  validateProject: projects.validateProject,
  cleanDraft: projects.cleanDraft,
  cleanSource: projects.cleanSource,
  sourceLabel: projects.sourceLabel,
  sourcePath: projects.sourcePath,
  repoName: projects.repoName,
  githubUrl: projects.githubUrl,
  repoFullName: projects.repoFullName,
  sameRepo: projects.sameRepo,
  toMountName: projects.toMountName,
  freeMountName: projects.freeMountName,
  baseName: projects.baseName,
  repoToDraft: projects.repoToDraft,
  toProjectDoc: ((id: string, d: Record<string, unknown>) => projects.toProjectDoc(id, d, (t) => (typeof t === "number" ? t : 0))) as Fn,
  reposToProjects: projects.reposToProjects,
  projectForRepo: projects.projectForRepo,
  findProject: projects.findProject,
  // the Builder's layers and catalog (the data itself is JSON: catalog.ts)
  catalog: (() => call("catalog")) as Fn,
  starters: (() => call("starters")) as Fn,
  signInKinds: layers.signInKinds,
  emptySetup: layers.emptySetup,
  setupOf: layers.setupOf,
  sameSetup: layers.sameSetup,
  webappId: layers.webappId,
  webappIcon: layers.webappIcon,
  imageKey: layers.imageKey,
  imageRef: layers.imageRef,
  resolve: layers.resolve,
  slotsFor: layers.slotsFor,
  browserSlots: layers.browserSlots,
  newSecretName: layers.newSecretName,
  defaultBrowserSecretName: layers.defaultBrowserSecretName,
  fits: layers.fits,
  kindOfSlotKey: layers.kindOfSlotKey,
  secretUse: layers.secretUse,
  opensFolders: layers.opensFolders,
  desktopFor: layers.desktopFor,
  startMenuFor: layers.startMenuFor,
  bootables: layers.bootables,
  layoutJsonFor: layers.layoutJsonFor,
  isExtensionId: layers.isExtensionId,
  templateDockerfile: layers.templateDockerfile,
  customizationDockerfile: layers.customizationDockerfile,
  templateLayer: layers.templateLayer,
  customizationLayer: layers.customizationLayer,
  wallpaperExt: layers.wallpaperExt,
  runSummary: layers.runSummary,
  workspaceFor: layers.workspaceFor,
  knownWebapps: layers.knownWebapps,
  named: layers.named,
  stacks: layers.stacks,
  nameTaken: layers.nameTaken,
  importable: layers.importable,
  importInto: layers.importInto,
};

export function run(fn: string, args: unknown[]): unknown {
  const f = IMPL[fn] ?? (((...a: unknown[]) => call(fn, ...a)) as Fn);
  try {
    return { out: plain(f(...(revive(args) as never[]))) };
  } catch (e) {
    return { err: (e as Error).message };
  }
}

describe("core goldens", () => {
  const all = cases();
  if (process.env.WRITE_GOLDENS) {
    it("writes fixtures/core/goldens.json", () => {
      const rows = all.map((c) => ({ fn: c.fn, args: plain(c.args), ...(run(c.fn, c.args) as object) }));
      writeFileSync(FILE, JSON.stringify(rows, null, 1) + "\n");
    });
    return;
  }
  it.runIf(existsSync(FILE))("every case matches", () => {
    const golden = JSON.parse(readFileSync(FILE, "utf8")) as { fn: string; args: unknown[]; out?: unknown; err?: string }[];
    expect(golden.length).toBe(all.length);
    for (const g of golden) {
      const { fn, args, ...want } = g;
      expect({ fn, ...(run(fn, args) as object) }, JSON.stringify(args).slice(0, 200)).toEqual({ fn, ...want });
    }
  });
});
