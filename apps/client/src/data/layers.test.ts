// The layers as the backends handle them (data/layers.ts): image states from
// the images' shas and what they were built on, and launcher items as wadd
// launches them.
import { describe, expect, it } from "vitest";
import { extensionsLayer, templateLayer, type Customization, type Template } from "@core/layers";
import { DEFAULT_BROWSERS, imageState, launchItem, workspaceSignIns, type ImageRow } from "./layers";

const t: Template = { id: "dev", owner: "me", name: "Dev", description: "", apps: ["wadbrowser", "vscode"], createdAt: "t", updatedAt: "t" };
const c: Customization = {
  id: "plus", owner: "me", name: "Plus", description: "", templateId: "dev", browserMode: "browser",
  webapps: [{ id: "github", name: "GitHub", url: "https://github.com" }], extensions: [], tools: ["go"], autostart: [], createdAt: "t", updatedAt: "t",
};
const lib = { templates: [t], customizations: [c] };
const row = (layer: ImageRow["layer"], sha: string, from = "base", id = `${layer}-id`): ImageRow => ({ layer, ref: layer, id, dockerfileSha: sha, builtAt: 1, sizeMb: 1, from });

describe("image states", () => {
  it("tells built, changed, never and building apart", () => {
    const tRow = row("template:dev", templateLayer(t).sha);
    const cRow = row("custom:plus", extensionsLayer(c, t).sha, tRow.id);
    const images = { "template:dev": tRow, "custom:plus": cRow };
    expect(imageState("template:dev", lib, images, new Set())).toBe("built");
    expect(imageState("custom:plus", lib, images, new Set())).toBe("built");
    expect(imageState("custom:plus", lib, {}, new Set())).toBe("never");
    expect(imageState("custom:plus", lib, images, new Set(["custom:plus"]))).toBe("building");
    // The customization changed since.
    expect(imageState("custom:plus", { ...lib, customizations: [{ ...c, tools: [] }] }, images, new Set())).toBe("changed");
    // Its template's image rebuilt since it was built on it.
    expect(imageState("custom:plus", lib, { ...images, "template:dev": { ...tRow, id: "newer" } }, new Set())).toBe("changed");
  });
});

describe("launcher items", () => {
  const projectsOf = (id: string) => (id === "academy" ? ["p1"] : []);

  it("are wadspaces with their projects, the machine's WadBrowsers and terminal, or setups", async () => {
    expect(await launchItem({ kind: "wadspace", wadspaceId: "academy" }, { background: false, projectsOf })).toEqual({ kind: "workspace", workspace: "academy", projects: ["p1"], background: false });
    expect(await launchItem({ kind: "terminal" }, { background: true, projectsOf })).toEqual({ kind: "terminal", background: true });
    expect(await launchItem({ kind: "browser", config: DEFAULT_BROWSERS[1] }, { background: true, projectsOf })).toEqual({ kind: "workspace", workspace: "browser-focus", projects: [], background: true });
    const mail = {
      id: "mail", name: "Mail", mode: "focus" as const,
      webapps: [{ id: "gmail", name: "Gmail", url: "https://mail.google.com" }],
      secrets: { "web:gmail": { id: "google-abc123", name: "Google", kind: "web" as const } },
    };
    expect(await launchItem({ kind: "browser", config: mail, savedId: "mail" }, { background: true, projectsOf })).toEqual({
      kind: "browser",
      setup: { name: "Mail", mode: "focus", webapps: mail.webapps, signins: [{ id: "google-abc123", app: "gmail", web: true, name: "Google", kind: "web", slot: "web:gmail" }] },
      savedId: "mail",
      background: true,
    });
  });

  it("mount each slot's sign-in for its app: a web app's id, VS Code for an extension", () => {
    expect(
      workspaceSignIns({
        "ext:anthropic.claude-code": { id: "cc", name: "Claude", kind: "vscode-claude-code" },
        "app:steam": { id: "st", name: "Steam", kind: "steam" },
      }),
    ).toEqual([
      { id: "cc", app: "vscode", name: "Claude", kind: "vscode-claude-code", slot: "ext:anthropic.claude-code" },
      { id: "st", app: "steam", name: "Steam", kind: "steam", slot: "app:steam" },
    ]);
  });
});
