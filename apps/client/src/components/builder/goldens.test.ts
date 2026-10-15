// fixtures/board/goldens.json: what the board's functions return for the
// corpus in goldens.ts. `WRITE_GOLDENS=1 npx vitest run src/components/builder/goldens.test.ts`
// rewrites the file from this implementation; otherwise every case is
// checked against it. The native client's board (crates/wad-board) checks
// the same file.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as catalog from "./catalog";
import { cases } from "./goldens";
import * as model from "./model";
import * as store from "./store";
import * as sync from "./sync";

const FILE = fileURLToPath(new URL("../../../../../fixtures/board/goldens.json", import.meta.url));

/** Results as JSON: undefined dropped (as JSON does). */
function plain(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, plain(x)]));
  return v === undefined ? null : v;
}

const appName = (id: string) => catalog.app(id)?.name ?? id;

type Fn = (...args: never[]) => unknown;
const IMPL: Record<string, Fn> = {
  toBoard: sync.toBoard as Fn,
  plan: sync.plan as Fn,
  withRefs: sync.withRefs as Fn,
  setupOfModule: sync.setupOfModule as Fn,
  customizationOf: sync.customizationOf as Fn,
  buildsOn: ((u: model.TemplateModule, l: model.TemplateModule) => model.buildsOn(u, l, appName)) as Fn,
  fitTemplates: ((c: model.TemplateModule[], a: model.TemplateModule[]) => model.fitTemplates(c, a, appName)) as Fn,
  isBlank: model.isBlank as Fn,
  moduleName: model.moduleName as Fn,
  strayApps: model.strayApps as Fn,
  missingFor: model.missingFor as Fn,
  statusOf: model.statusOf as Fn,
  stackName: model.stackName as Fn,
  browserItems: catalog.browserItems as Fn,
  keyGroupsOf: ((s: model.Stack) => catalog.keyGroupsOf(s, model.subOf(s.customization, "secrets"))) as Fn,
  keyMap: ((s: model.Stack) => catalog.keyMap(s)) as Fn,
  keyCount: catalog.keyCount as Fn,
  webKey: catalog.webKey as Fn,
  problemsOf: catalog.problemsOf as Fn,
  secretSlots: catalog.secretSlots as Fn,
  desktopOf: catalog.desktopOf as Fn,
  setupsFor: catalog.setupsFor as Fn,
  subFits: ((k: model.AppSubKey, apps: string[] | null) => catalog.subFits(k, apps ?? undefined)) as Fn,
  extSig: store.extSig as Fn,
  nameClash: store.nameClash as Fn,
  grab: store.grab as Fn,
  keysOfKind: store.keysOfKind as Fn,
  copyName: store.copyName as Fn,
  chainUnder: store.chainUnder as Fn,
  sameApps: store.sameApps as Fn,
  place: store.place as Fn,
};

function run(fn: string, args: unknown[]): { out: unknown } | { err: string } {
  const f = IMPL[fn];
  if (!f) throw new Error(`no ${fn}`);
  try {
    return { out: plain(f(...(args as never[]))) };
  } catch (e) {
    return { err: (e as Error).message };
  }
}

describe("the board's goldens", () => {
  it("are what the board's functions return", () => {
    const got = cases().map((c) => ({ fn: c.fn, args: c.args, ...run(c.fn, c.args) }));
    if (process.env.WRITE_GOLDENS === "1") {
      mkdirSync(dirname(FILE), { recursive: true });
      writeFileSync(FILE, `${JSON.stringify(got, null, 1)}\n`);
      return;
    }
    const want = JSON.parse(readFileSync(FILE, "utf8"));
    expect(got).toEqual(want);
  });
});
