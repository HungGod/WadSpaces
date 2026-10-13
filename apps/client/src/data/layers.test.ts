// The layers as the backends handle them (data/layers.ts and migrate.ts):
// image states from the images' shas and what they were built on (all the
// way down a chain of templates), build and install requests, launcher items
// as wadd launches them, and a library moved to stacks.
import { describe, expect, it } from "vitest";
import { extensionsLayer, templateLayer, type Extensions, type Template, type Wadspace } from "@core/layers";
import { DEFAULT_BROWSERS, imageState, installBody, launchItem, layerRequest, notReady, type ImageRow } from "./layers";
import { applied, migration } from "./migrate";
import { legacyBackend, sampleBackend } from "@/test/sample";

const t: Template = { id: "dev", owner: "me", name: "Dev", description: "", apps: ["wadbrowser", "vscode"], createdAt: "t", updatedAt: "t" };
const game: Template = { ...t, id: "game", name: "Game Dev", parent: "dev", apps: ["wadbrowser", "vscode", "tiled"] };
const c: Extensions = {
  id: "plus", owner: "me", name: "Plus", description: "", templateId: "dev", browserMode: "browser",
  webapps: [{ id: "github", name: "GitHub", url: "https://github.com" }], extensions: [], tools: ["go"], autostart: [], createdAt: "t", updatedAt: "t",
};
const lib = { templates: [t, game], extensions: [c] };
const row = (layer: ImageRow["layer"], sha: string, from = "base", id = `${layer}-id`): ImageRow => ({ layer, ref: layer, id, dockerfileSha: sha, builtAt: 1, sizeMb: 1, from });

describe("image states", () => {
  const tRow = row("template:dev", templateLayer(t).sha);
  const gRow = row("template:game", templateLayer(game, t).sha, tRow.id);
  const cRow = row("custom:plus", extensionsLayer(c, t).sha, tRow.id);
  const images = { "template:dev": tRow, "template:game": gRow, "custom:plus": cRow };

  it("tells built, changed, never and building apart", () => {
    expect(imageState("template:dev", lib, images, new Set())).toBe("built");
    expect(imageState("custom:plus", lib, images, new Set())).toBe("built");
    expect(imageState("custom:plus", lib, {}, new Set())).toBe("never");
    expect(imageState("custom:plus", lib, images, new Set(["custom:plus"]))).toBe("building");
    // The Extensions changed since.
    expect(imageState("custom:plus", { ...lib, extensions: [{ ...c, tools: [] }] }, images, new Set())).toBe("changed");
    // Its template's image rebuilt since it was built on it.
    expect(imageState("custom:plus", lib, { ...images, "template:dev": { ...tRow, id: "newer" } }, new Set())).toBe("changed");
  });

  it("follows a template down its chain", () => {
    expect(imageState("template:game", lib, images, new Set())).toBe("built");
    // Dev rebuilt under it: Game Dev is out of date even with the same build folder.
    expect(imageState("template:game", lib, { ...images, "template:dev": { ...tRow, id: "newer" } }, new Set())).toBe("changed");
    // Dev changed (not rebuilt yet): so is what's on it.
    const devMore = { ...t, apps: ["wadbrowser", "vscode", "krita"] };
    expect(imageState("template:game", { ...lib, templates: [devMore, game] }, images, new Set())).toBe("changed");
  });
});

describe("requests", () => {
  const stack: Wadspace = {
    version: 3, id: "s", owner: "me", order: 1, template: "game",
    customization: { name: "Game", description: "", wallpaper: { type: "color", value: "#000" }, projects: [], secrets: { bySlot: {} } },
    createdAt: "t", updatedAt: "t",
  };

  it("build a template with what it builds on, bottom first", () => {
    expect(layerRequest("template:game", lib)).toEqual({ layer: "template:game", template: game, parents: [t], extensions: null });
    expect(layerRequest("custom:plus", lib)).toEqual({ layer: "custom:plus", template: t, parents: [], extensions: c });
    expect(() => layerRequest("template:gone", lib)).toThrow("That template is gone.");
  });

  it("install a stack on its top layer, once it has a template and a named customization", () => {
    expect(installBody(stack, lib, "Pacific/Fiji")).toEqual({ wadspace: stack, template: game, extensions: null, tz: "Pacific/Fiji" });
    expect(notReady(stack, lib)).toBeNull();
    expect(notReady({ ...stack, template: undefined }, lib)).toBe("It needs a template with apps.");
    expect(notReady({ ...stack, customization: undefined }, lib)).toBe("It needs a customization.");
    expect(notReady({ ...stack, customization: { ...stack.customization!, name: " " } }, lib)).toBe("Its customization needs a name.");
  });
});

describe("launcher items", () => {
  const b = sampleBackend();
  const full = { templates: [...b.templates.values()], extensions: [...b.extensions.values()], wadspaces: [...b.wadspaces.values()] as Wadspace[] };

  it("are wadspaces, the machine's WadBrowsers and terminal, or setups", async () => {
    expect(await launchItem({ kind: "wadspace", wadspaceId: "vanua-academy" }, { background: false, lib: full })).toEqual({ kind: "workspace", workspace: "vanua-academy", background: false });
    expect(await launchItem({ kind: "terminal" }, { background: true, lib: full })).toEqual({ kind: "terminal", background: true });
    expect(await launchItem({ kind: "browser", config: DEFAULT_BROWSERS[1] }, { background: true, lib: full })).toEqual({ kind: "workspace", workspace: "browser-focus", background: true });
    const mail = {
      id: "mail", name: "Mail", mode: "focus" as const,
      webapps: [{ id: "gmail", name: "Gmail", url: "https://mail.google.com" }],
      secrets: { "web:gmail": { id: "google-abc123", name: "Google", kind: "web" as const } },
    };
    expect(await launchItem({ kind: "browser", config: mail, savedId: "mail" }, { background: true, lib: full })).toEqual({
      kind: "browser",
      setup: { name: "Mail", mode: "focus", webapps: mail.webapps, signins: [{ id: "google-abc123", app: "gmail", web: true, name: "Google", kind: "web", slot: "web:gmail" }] },
      savedId: "mail",
      background: true,
    });
  });
});

describe("moving a library to stacks", () => {
  it("moves the Extensions layers and turns each version 2 wadspace into a stack", async () => {
    const b = legacyBackend();
    const docs = {
      templates: await b.listTemplates(),
      customizations: await b.listOldCustomizations(),
      extensions: await b.listExtensions(),
      wadspaces: await b.listWadspaces(),
      projects: await b.listProjects(),
    };
    const m = migration(docs)!;
    expect(m.extensions.map((e) => e.id)).toEqual(["vanua-academy-dev"]);
    expect(m.dropCustomizations).toEqual(["vanua-academy-dev"]);
    // Oldest first, after any stack already there.
    expect(m.wadspaces.map((w) => [w.id, w.order])).toEqual([["cosmic-bodybuilding", 1], ["vanua-academy", 2]]);
    const sample = sampleBackend();
    const [cosmic, vanua] = m.wadspaces;
    // As the sample has them, but Cosmic's folder project is a copy now.
    expect(vanua).toEqual(sample.wadspaces.get("vanua-academy"));
    expect(cosmic.customization!.projects).toEqual([{ id: "writing", kind: "copy", source: { machineId: "local", paths: ["/home/me/Writing"] }, as: "Writing" }]);
    const shown = applied(docs.wadspaces, docs.extensions, m);
    expect(shown.wadspaces.map((w) => w.version)).toEqual([3, 3]);
    expect(shown.extensions.map((e) => e.id)).toEqual(["vanua-academy-dev"]);
    // Moved: nothing more to move.
    expect(migration({ ...docs, customizations: [], extensions: shown.extensions, wadspaces: shown.wadspaces })).toBeNull();
  });
});
