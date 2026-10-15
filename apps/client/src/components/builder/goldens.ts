// The golden corpus for the Builder's board (model.ts, sync.ts, catalog.ts
// and the store's pure parts): the functions the native client's wad-board
// crate ports, over the sample library and boards made from it to cover
// their branches (shared and lone templates and Extensions, chains, drafts,
// deleted stacks, misconfiguration, names that clash). fixtures/board/
// goldens.json holds what they returned; wad-board must return the same.
// goldens.test.ts writes and checks them. Functions that make ids (copies,
// new stacks) aren't here: wad-board's own tests cover those.
import type { Extensions, Template, Wadspace } from "@core/layers";
import { sampleBackend } from "@/test/sample";
import type { CustomizationModule, ExtensionsModule, Module, Stack, TemplateModule } from "./model";
import { toBoard, type Docs } from "./sync";

export interface Case {
  fn: string;
  args: unknown[];
}

const NOW = "2026-10-13T00:00:00.000Z";

function sampleDocs(): Docs {
  const b = sampleBackend();
  return { templates: [...b.templates.values()], extensions: [...b.extensions.values()], wadspaces: [...b.wadspaces.values()] as Wadspace[] };
}

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const edit = (stacks: Stack[], id: string, f: (s: Stack) => Stack) => stacks.map((s) => (s.id === id ? f(clone(s)) : clone(s)));

export function cases(): Case[] {
  const out: Case[] = [];
  const add = (fn: string, ...args: unknown[]) => out.push({ fn, args: clone(args) });

  const d = sampleDocs();
  const board = toBoard(d);
  const [cosmic, vanua] = board;
  const dev = vanua.templates[0];
  const writing = cosmic.templates[0];

  // A Dev + Tiled template on Dev, a draft on top, Extensions with no template, a deleted stack, a tie in order.
  const devTiled: Template = { id: "dev-tiled", owner: "me", name: "Game Dev", description: "Dev and Tiled", apps: ["wadbrowser", "vscode", "tiled"], parent: "dev", createdAt: NOW, updatedAt: NOW };
  const loneExt: Extensions = { ...(d.extensions[0] as Extensions), id: "lone", name: "Lone", templateId: "dev-tiled", webapps: [], extensions: ["rust-lang.rust-analyzer"], tools: ["rust"] };
  const more: Docs = {
    templates: [...d.templates, devTiled],
    extensions: [...d.extensions, loneExt],
    wadspaces: [
      ...d.wadspaces,
      { version: 3, id: "game", owner: "me", order: 3, template: "dev-tiled", extensions: "lone", createdAt: "2026-10-02T00:00:00.000Z", updatedAt: NOW } as Wadspace,
      { version: 3, id: "draft-top", owner: "me", order: 3, template: "dev", draftTemplate: { name: "Next", description: "" }, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: NOW } as Wadspace,
      { version: 3, id: "loose", owner: "me", order: 4, draftExtensions: { name: "Loose", browserMode: "focus", webapps: [], extensions: [], tools: ["go"], autostart: [] }, createdAt: NOW, updatedAt: NOW } as Wadspace,
      { version: 3, id: "gone", owner: "me", order: 0, template: "writing", deletedAt: NOW, createdAt: NOW, updatedAt: NOW } as Wadspace,
    ],
  };
  const bigBoard = toBoard(more);

  // ------------------------------------------------------------- toBoard
  add("toBoard", d);
  add("toBoard", more);
  add("toBoard", { templates: [], extensions: [], wadspaces: [] });

  // --------------------------------------------------------------- plan
  const plan = (stacks: Stack[], docs: Docs = d) => add("plan", stacks, docs, "me", NOW);
  plan(board);
  plan(bigBoard, more);
  // Renamed (Cosmic's template), described, reordered, a stack gone.
  plan(edit(board, "cosmic-bodybuilding", (s) => ({ ...s, templates: [{ ...s.templates[0], name: "Writer" }] })));
  plan(edit(board, "vanua-academy", (s) => ({ ...s, templates: [{ ...s.templates[0], description: "Changed" }] })));
  plan([clone(vanua), clone(cosmic)]);
  plan([clone(vanua)]);
  // An app added to Dev: no other stack has it, so it changes in place …
  plan(edit(board, "vanua-academy", (s) => ({ ...s, templates: [{ ...s.templates[0], apps: [...s.templates[0].apps, "tiled"] }] })));
  // … but with a second stack on Dev, a new template is made for the change.
  const twoOnDev: Stack[] = [...clone(board), { ...clone(vanua), id: "vanua-2" }];
  plan(twoOnDev);
  plan(edit(twoOnDev, "vanua-2", (s) => ({ ...s, templates: [{ ...s.templates[0], apps: [...s.templates[0].apps, "krita"] }] })));
  // The same apps as another template: that one's used (a twin).
  plan(edit(board, "cosmic-bodybuilding", (s) => ({ ...s, templates: [{ ...s.templates[0], ref: undefined, name: "Dev again", apps: ["vscode", "wadbrowser"] }] })));
  // A new stack: a new template (its id from its name, free), Extensions on it, a customization.
  const fresh: Stack = {
    id: "stack-new",
    templates: [{ layer: "template", id: "t-new", name: "Writing", description: "", apps: ["obsidian", "krita"] }],
    extensions: { layer: "extensions", id: "e-new", name: "Art", subs: [{ key: "tools", id: "s1", origin: "Art", tools: ["python"] }], autostart: [] },
    customization: clone(cosmic.customization!),
  };
  plan([...clone(board), fresh]);
  // A blank template on top waits as a draft; Extensions with no template are kept in the stack.
  plan(edit(board, "cosmic-bodybuilding", (s) => ({ ...s, templates: [...s.templates, { layer: "template", id: "t-blank", name: "Next", description: "Soon", apps: [] }] })));
  plan([...clone(board), { id: "only-ext", templates: [], extensions: clone(vanua.extensions!) }]);
  // Extensions changed: theirs alone (in place), or shared (a new one), or the same as another (that one).
  const fewerApps = (s: Stack): Stack => ({ ...s, extensions: { ...s.extensions!, subs: s.extensions!.subs.map((x) => (x.key === "wadbrowser" ? { ...x, webapps: x.webapps.slice(0, 2) } : x)) } });
  plan(edit(board, "vanua-academy", fewerApps));
  plan(edit(twoOnDev, "vanua-2", fewerApps));
  plan(edit(board, "vanua-academy", (s) => ({ ...s, extensions: { ...s.extensions!, name: "Renamed Ext" } })));
  // A chain: Game Dev on Dev, and one more on top.
  plan(edit(bigBoard, "game", (s) => ({ ...s, templates: [...s.templates, { layer: "template", id: "t3", name: "Game Dev + Art", description: "", apps: ["wadbrowser", "vscode", "tiled", "krita"] }] })), more);
  // A deleted stack back on the board.
  plan([...clone(board), { id: "gone", templates: [clone(writing)] }], more);
  // A customization taken off; and one changed.
  plan(edit(board, "cosmic-bodybuilding", (s) => ({ id: s.id, templates: s.templates })));
  plan(edit(board, "cosmic-bodybuilding", (s) => ({ ...s, customization: { ...s.customization!, subs: s.customization!.subs.map((x) => (x.key === "look" ? { ...x, name: "Cosmic 2" } : x)) } as CustomizationModule })));

  // ----------------------------------------------------------- withRefs
  add("withRefs", board, { [dev.id]: "dev-2", [vanua.extensions!.id]: "ext-2" });
  add("withRefs", [fresh], { "t-new": "writing-2", "e-new": "art" });
  add("withRefs", board, {});

  // -------------------------------------------------- setups and keys out
  add("setupOfModule", vanua.extensions);
  add("setupOfModule", { layer: "extensions", id: "x", name: "X", subs: [] });
  add("customizationOf", vanua.customization);
  add("customizationOf", cosmic.customization);
  add("customizationOf", { layer: "customization", id: "c", subs: [] });

  // -------------------------------------------------------- model checks
  const tiled: TemplateModule = { layer: "template", id: "t-tiled", name: "Game Dev", description: "", apps: ["wadbrowser", "vscode", "tiled"] };
  const krita: TemplateModule = { layer: "template", id: "t-krita", name: "Art", description: "", apps: ["krita"] };
  add("buildsOn", tiled, dev);
  add("buildsOn", dev, tiled);
  add("buildsOn", dev, dev);
  add("buildsOn", krita, dev);
  add("fitTemplates", [dev], [tiled]);
  add("fitTemplates", [tiled], [dev]);
  add("fitTemplates", [dev, tiled], [krita]);
  add("fitTemplates", [], [krita]);
  const blankTemplate: TemplateModule = { layer: "template", id: "b", name: "New", description: "", apps: [] };
  const blankExt: ExtensionsModule = { layer: "extensions", id: "be", name: "New", subs: [] };
  const blankCustom: CustomizationModule = { layer: "customization", id: "bc", subs: [{ key: "look", id: "l", origin: "", name: " ", description: "", wallpaper: { type: "gradient", value: "linear-gradient(135deg, #140d22, #241a39)" } }] };
  for (const m of [blankTemplate, blankExt, blankCustom, dev, vanua.extensions!, vanua.customization!, { layer: "customization", id: "e", subs: [] }] as Module[]) {
    add("isBlank", m);
    add("moduleName", m);
  }
  const misconfigured: Stack = { ...clone(vanua), templates: [{ ...dev, apps: ["obsidian"] }] };
  const strayKey: Stack = edit([vanua], vanua.id, (s) => ({
    ...s,
    customization: { ...s.customization!, subs: s.customization!.subs.map((x) => (x.key === "secrets" ? { ...x, bySlot: { ...x.bySlot, "ext:openai.chatgpt": { id: "k9", name: "Codex", kind: "vscode-codex" as const } } } : x)) } as CustomizationModule,
  }))[0];
  const groupsGone: Stack = edit([vanua], vanua.id, (s) => ({
    ...s,
    customization: {
      ...s.customization!,
      subs: s.customization!.subs.map((x) => (x.key === "secrets" ? { ...x, groups: [{ id: "empty", members: [] }, { id: "g1", members: ["web:gone", "web:github"] }] } : x)),
    } as CustomizationModule,
  }))[0];
  const stacks: Stack[] = [cosmic, vanua, misconfigured, strayKey, groupsGone, { id: "nothing", templates: [] }, { id: "blank", templates: [blankTemplate] }, { id: "ext-only", templates: [], extensions: vanua.extensions }, ...bigBoard];
  for (const s of stacks) {
    for (const fn of ["strayApps", "missingFor", "statusOf", "stackName", "browserItems", "keyMap", "keyCount", "problemsOf", "secretSlots", "desktopOf", "extSig"]) add(fn, s);
    add("keyGroupsOf", s);
    add("webKey", s, "web:github");
    add("webKey", s, "browser");
  }
  add("setupsFor", ["wadbrowser", "vscode"]);
  add("setupsFor", ["obsidian"]);
  for (const key of ["vscode", "wadbrowser", "tools"]) {
    add("subFits", key, ["obsidian"]);
    add("subFits", key, ["wadbrowser", "vscode"]);
    add("subFits", key, null);
  }

  // ------------------------------------------------------- the store's
  add("nameClash", board, "cosmic-bodybuilding", cosmic.customization, "vanuaacademy");
  add("nameClash", board, "cosmic-bodybuilding", cosmic.customization, "Cosmic Bodybuilding");
  add("nameClash", board, "cosmic-bodybuilding", writing, "Dev");
  add("nameClash", twoOnDev, "vanua-2", twoOnDev[2].templates[0], "dev");
  add("nameClash", twoOnDev, "vanua-2", twoOnDev[2].extensions, "VanuaAcademy Dev");
  add("nameClash", [...clone(board), { ...clone(cosmic), id: "c2", extensions: { ...clone(vanua.extensions!), id: "other-ext", subs: [] } }], "c2", { ...vanua.extensions!, id: "other-ext", subs: [] }, "VanuaAcademy Dev");
  add("nameClash", board, "vanua-academy", dev, "  ");
  for (const [id, only] of [[dev.id, false], [dev.id, true], [vanua.extensions!.id, false], [vanua.customization!.id, true], ["nope", false]] as const) add("grab", vanua, id, only);
  const keys = [{ id: "s-github", name: "Me-WadBrowser-Github", kind: "web" }, { id: "x", name: "Steam", kind: "steam" }];
  add("keysOfKind", keys, board, "web");
  add("keysOfKind", keys, board, "vscode-claude-code");
  add("keysOfKind", [], [], "steam");
  add("copyName", "Vanua", ["Vanua - 1", "Vanua - 3", "Other"]);
  add("copyName", "Vanua - 2", ["Vanua", "Vanua - 2"]);
  add("copyName", " ", []);
  add("copyName", "a.b (c)", ["a.b (c) - 4"]);
  add("chainUnder", tiled, bigBoard);
  add("chainUnder", { ...tiled, apps: ["wadbrowser", "vscode", "tiled", "krita"] }, bigBoard);
  add("chainUnder", krita, board);
  add("sameApps", dev, { ...dev, apps: ["vscode", "wadbrowser"] });
  add("sameApps", dev, tiled);
  add("place", cosmic, [vanua.extensions]);
  add("place", vanua, [tiled]);
  add("place", vanua, [krita]);
  add("place", { id: "empty", templates: [] }, [dev, tiled, vanua.extensions, cosmic.customization]);
  add("place", vanua, [tiled, dev]);
  add("place", cosmic, [cosmic.customization, vanua.extensions]);
  return out;
}
