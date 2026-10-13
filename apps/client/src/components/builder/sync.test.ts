// The board and its documents (sync.ts): read as stacks and written back
// unchanged; templates and Extensions shared while they're the same, copied
// when one stack changes them, changed in place when no other stack has them;
// chains, drafts, order and deleted stacks.
import { describe, expect, it } from "vitest";
import { sampleBackend } from "@/test/sample";
import type { Wadspace } from "@core/layers";
import { cloneModule, subOf, type Stack, type TemplateModule } from "./model";
import { plan, toBoard, withRefs, writes, type Docs } from "./sync";

const NOW = "2026-10-13T00:00:00.000Z";

function docs(): Docs {
  const b = sampleBackend();
  return { templates: [...b.templates.values()], extensions: [...b.extensions.values()], wadspaces: [...b.wadspaces.values()] as Wadspace[] };
}

const go = (stacks: Stack[], d: Docs) => plan(stacks, d, "me", NOW);
const replace = (stacks: Stack[], id: string, f: (s: Stack) => Stack) => stacks.map((s) => (s.id === id ? f(s) : s));

describe("the board and its documents", () => {
  it("reads the documents as stacks, and writes nothing back for them", () => {
    const d = docs();
    const stacks = toBoard(d);
    expect(stacks.map((s) => [s.id, s.templates.map((t) => t.ref), s.extensions?.ref ?? null])).toEqual([
      ["cosmic-bodybuilding", ["writing"], null],
      ["vanua-academy", ["dev"], "vanua-academy-dev"],
    ]);
    const vanua = stacks[1];
    expect(subOf(vanua.extensions, "wadbrowser")?.webapps.length).toBe(7);
    expect(subOf(vanua.customization, "look")?.name).toBe("VanuaAcademy");
    expect(subOf(vanua.customization, "secrets")?.groups?.length).toBe(5);
    expect(writes(go(stacks, d))).toBe(false);
  });

  it("shares a template copied onto another stack: the same document", () => {
    const d = docs();
    const stacks = toBoard(d);
    // Dev copied under Cosmic's template's place: Cosmic now runs on Dev.
    const dev = cloneModule(stacks[1].templates[0], false);
    const next = replace(stacks, "cosmic-bodybuilding", (s) => ({ ...s, templates: [dev] }));
    const p = go(next, d);
    expect(p.templates).toEqual([]);
    expect(p.wadspaces.map((w) => [w.id, w.template])).toEqual([["cosmic-bodybuilding", "dev"]]);
    expect(p.refs[dev.id]).toBe("dev");
  });

  it("copies a shared template that one stack changes, and changes one that's its alone", () => {
    const d = docs();
    const stacks = toBoard(d);
    const two = [...stacks, { ...stacks[1], id: "vanua-2", templates: stacks[1].templates.map((t) => cloneModule(t, false)), customization: undefined, extensions: undefined }];
    const shared = go(two, d);
    const withTwo = shared.docs;
    // Dev is in two stacks now: Tiled added in one copies it.
    const grown = replace(two, "vanua-2", (s) => ({ ...s, templates: [{ ...s.templates[0], name: "Dev - 1", apps: [...s.templates[0].apps, "tiled"] }] }));
    const p = go(grown, withTwo);
    expect(p.templates.map((t) => [t.id, t.name, t.apps])).toEqual([["dev-1", "Dev - 1", ["wadbrowser", "vscode", "tiled"]]]);
    expect(p.docs.templates.find((t) => t.id === "dev")!.apps).toEqual(["wadbrowser", "vscode"]);
    // Writing is only Cosmic's: changed where it is.
    const writing = replace(stacks, "cosmic-bodybuilding", (s) => ({ ...s, templates: [{ ...s.templates[0], apps: ["obsidian", "krita"] }] }));
    const q = go(writing, d);
    expect(q.templates.map((t) => [t.id, t.apps])).toEqual([["writing", ["obsidian", "krita"]]]);
  });

  it("renames a shared template everywhere: it's one document", () => {
    const d = docs();
    const stacks = toBoard(d);
    const p = go(replace(stacks, "vanua-academy", (s) => ({ ...s, templates: [{ ...s.templates[0], name: "Developer" }] })), d);
    expect(p.templates.map((t) => [t.id, t.name])).toEqual([["dev", "Developer"]]);
  });

  it("builds a chain: a template on another, its parent the one below", () => {
    const d = docs();
    const stacks = toBoard(d);
    const game: TemplateModule = { layer: "template", id: "template-game", name: "Game Dev", description: "", apps: ["wadbrowser", "vscode", "tiled"] };
    const p = go(replace(stacks, "vanua-academy", (s) => ({ ...s, templates: [...s.templates, game] })), d);
    expect(p.templates).toEqual([expect.objectContaining({ id: "game-dev", parent: "dev", apps: ["wadbrowser", "vscode", "tiled"] })]);
    // Its Extensions were made on Dev: on Game Dev now, they're a new layer.
    expect(p.extensions).toEqual([expect.objectContaining({ templateId: "game-dev", name: "VanuaAcademy Dev" })]);
    expect(p.wadspaces[0]).toEqual(expect.objectContaining({ template: "game-dev", extensions: p.extensions[0].id }));
    // Read back, the stack has its chain.
    expect(toBoard(p.docs)[1].templates.map((t) => t.ref)).toEqual(["dev", "game-dev"]);
    const again = withRefs(toBoard(p.docs), {});
    expect(writes(go(again, p.docs))).toBe(false);
  });

  it("keeps a blank template, and Extensions with no template, in the stack until they're real", () => {
    const d = docs();
    const blank: Stack = {
      id: "stack-new",
      templates: [{ layer: "template", id: "template-x", name: "New template", description: "", apps: [] }],
      extensions: { layer: "extensions", id: "ext-x", name: "Loose", subs: [{ key: "tools", id: "t", origin: "", tools: ["go"] }] },
    };
    const p = go([...toBoard(d), blank], d);
    const w = p.wadspaces.find((x) => x.id === "stack-new")!;
    expect(w).toEqual(expect.objectContaining({ version: 3, order: 3, draftTemplate: { name: "New template", description: "" } }));
    expect(w.draftExtensions).toEqual(expect.objectContaining({ name: "Loose", tools: ["go"] }));
    expect(w.template).toBeUndefined();
    expect(p.templates).toEqual([]);
    const back = toBoard(p.docs).find((s) => s.id === "stack-new")!;
    expect([back.templates[0].apps, back.extensions?.name]).toEqual([[], "Loose"]);
  });

  it("orders the stacks as the board has them, and deletes the ones gone softly", () => {
    const d = docs();
    const [cosmic, vanua] = toBoard(d);
    const swapped = go([vanua, cosmic], d);
    expect(swapped.wadspaces.map((w) => [w.id, w.order])).toEqual([["vanua-academy", 1], ["cosmic-bodybuilding", 2]]);
    const gone = go([vanua], d);
    expect(gone.deleted).toEqual(["cosmic-bodybuilding"]);
    expect(gone.docs.wadspaces.find((w) => w.id === "cosmic-bodybuilding")!.deletedAt).toBe(NOW);
    expect(toBoard(gone.docs).map((s) => s.id)).toEqual(["vanua-academy"]);
  });
});
