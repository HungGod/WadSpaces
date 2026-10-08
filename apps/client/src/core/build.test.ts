import { describe, expect, it } from "vitest";
import apps from "@core-data/apps.json";
import { recipeFor } from "./catalog/recipes";
import { layoutJson, toBuildSpec } from "./build";
import { dockerfile } from "./generator";
import { defaultAdvanced, newWadspaceId, orderedIcons, type LayoutIcon, type WadspaceSpec } from "./model";
import { validateProject } from "./projects";
import { presets, presetProjects, presetWadspace } from "./presets";
import { ID_RE } from "./spec";

const icon = (appId: string, row: number, extra: Partial<LayoutIcon> = {}): LayoutIcon => ({
  id: `${appId}-${row}`,
  appId,
  label: apps.find((a) => a.id === appId)?.name ?? appId,
  iconUrl: "",
  color: "#000",
  x: 0,
  y: 0,
  cell: { col: 0, row },
  ...extra,
});

const ws = (icons: LayoutIcon[]): WadspaceSpec => ({
  id: "test-abc123",
  name: "Test",
  description: "",
  layout: { wallpaper: { type: "color", value: "#000" }, icons, grid: true },
  advanced: defaultAdvanced("Pacific/Fiji"),
});

// Every catalog app has a recipe, with plain Debian package names: wad-core's
// recipes tests check that (crates/wad-core/src/recipes.rs).
describe("catalog", () => {
  it("an unknown app with a site is a web app", () => {
    expect(recipeFor("custom-x1", "example.com/app")).toEqual({ kind: "webapp", url: "https://example.com/app" });
    expect(recipeFor("custom-x1").kind).toBe("soon");
  });
});

describe("toBuildSpec", () => {
  const plan = toBuildSpec(
    ws([
      icon("vscode", 0, { autostart: true }),
      icon("gimp", 1),
      icon("github", 2),
      icon("claude", 3, { launcher: "kale" }), // saved before WadBrowser
      icon("unity", 4),
      icon("custom-k1", 5, { label: "My Site", url: "https://my.site" }),
      // A cloud-file shortcut saved before cloud files were removed.
      icon("file:f1", 6, { kind: "file", fileId: "f1" } as Partial<LayoutIcon>),
      icon("vscode", 7), // a second VS Code icon is the same app
    ]),
    { wallpaperFile: "wallpaper.png" },
  );

  it("installs each app the way its recipe says", () => {
    expect(plan.spec.features).toEqual(expect.arrayContaining(["git", "vscode"]));
    expect(plan.spec.aptApps).toEqual([{ id: "gimp", packages: ["gimp"], desktop: "gimp.desktop" }]);
    // Every web app is a WadBrowser window, the old Kale ones too.
    expect(plan.spec.webapps).toEqual([
      { id: "github", name: "GitHub", url: "https://github.com" },
      { id: "claude", name: "Claude", url: "https://claude.ai" },
      { id: "custom-k1", name: "My Site", url: "https://my.site" },
    ]);
  });

  it("reports what it can't install yet", () => {
    expect(plan.skipped).toEqual([{ label: "Unity", reason: expect.stringMatching(/coming soon/) }]);
  });

  it("keeps the desktop order in layout.json, without duplicates or old file shortcuts", () => {
    expect(plan.spec.layout!.map((l) => l.app)).toEqual(["vscode", "gimp", "github", "claude", "custom-k1"]);
    expect(plan.spec.layout![0]).toEqual({ app: "vscode", desktop: "wadspaces-vscode.desktop", label: "VS Code", autostart: true });
    expect(plan.spec.layout![3]).toEqual({ app: "claude", desktop: "wadspaces-webapp-claude.desktop", label: "Claude" });
    expect(JSON.parse(layoutJson(plan.spec)).icons).toHaveLength(5);
  });

  it("generates a Dockerfile with the new helpers", () => {
    const df = dockerfile(plan.spec);
    // Web apps need no Chrome: WadBrowser is in the base.
    expect(df).toContain("RUN wadspaces-feature git vscode\n");
    expect(df).toContain("wadspaces-apt gimp --desktop gimp.desktop gimp && \\\n    wadspaces-apt --clean");
    expect(df).toContain('wadspaces-webapp --id github "GitHub" https://github.com');
    expect(df).not.toContain("kalebrowser");
    expect(df).toContain("ARG BASE_IMAGE=localhost/wadspaces-base:trixie");
  });

  it("links open in the WadBrowser on the desktop; DRM and call sites stay on Chrome", () => {
    const full = toBuildSpec(ws([icon("wadbrowser-focus", 0), icon("wadbrowser", 1), icon("spotify", 2)])).spec;
    expect(full.defaultBrowser).toBe("full");
    expect(full.webapps).toEqual([{ id: "spotify", name: "Spotify", url: "https://open.spotify.com", chrome: true }]);
    expect(dockerfile(full)).toContain('wadspaces-webapp --id spotify --chrome "Spotify" https://open.spotify.com');
    expect(dockerfile(full)).toContain("RUN wadspaces-feature git chrome\n");
    expect(toBuildSpec(ws([icon("wadbrowser-focus", 0)])).spec.defaultBrowser).toBe("focus");
    expect(toBuildSpec(ws([icon("gmail", 0)])).spec.defaultBrowser).toBeUndefined();
  });

  it("names the image after the wadspace unless told otherwise", () => {
    expect(plan.spec.image).toBe("localhost/wadspaces-test-abc123:latest");
    expect(toBuildSpec(ws([]), { image: "reg/x@sha256:1" }).spec.image).toBe("reg/x@sha256:1");
  });
});

describe("model", () => {
  it("wadspace ids are valid wadd ids", () => {
    for (const name of ["Deep Work!", "", "ünïcødé", "a".repeat(80)]) expect(newWadspaceId(name)).toMatch(ID_RE);
  });

  it("orders free-placed icons top to bottom, left to right", () => {
    const layout = { wallpaper: { type: "color" as const, value: "#000" }, grid: false, icons: [icon("b", 0, { x: 0.5, y: 0.1 }), icon("a", 1, { x: 0.02, y: 0.4 }), icon("c", 2, { x: 0.02, y: 0.1 })] };
    expect(orderedIcons(layout).map((i) => i.appId)).toEqual(["c", "a", "b"]);
  });
});

describe("presets as Builder wadspaces", () => {
  it("every preset has a desktop and keeps its run settings", () => {
    for (const p of presets()) {
      const w = presetWadspace(p.id)!;
      expect(w.layout.icons.length).toBeGreaterThan(0);
      expect(w.advanced.hotkey).toBe(p.hotkey);
      expect(w.advanced.display).toBe(p.display);
      expect(w.advanced.projects).toEqual([]);
      expect(presetProjects(p.id).length).toBe(1);
      for (const d of presetProjects(p.id)) expect(validateProject(d)).toEqual([]);
    }
  });

  it("Writing keeps its Desktop folder (init-writing-vault needs ~/Desktop/Writing)", () => {
    expect(presetProjects("writing").map((d) => d.mountName)).toEqual(["Writing"]);
  });

  it("names the default projects it's given, in order, skipping unknown ones", () => {
    const w = { ...ws([]), advanced: { ...defaultAdvanced("Etc/UTC"), projects: ["p2", "gone", "p1"] } };
    const mk = (id: string, name: string) => ({ id, name, mountName: name, source: { kind: "git" as const, url: `https://github.com/you/${name}` }, setup: "", deleted: false, createdAt: 0, updatedAt: 0 });
    const { spec } = toBuildSpec(w, { projects: [mk("p1", "Notes"), mk("p2", "Writing")] });
    expect(spec.projects).toEqual([
      { id: "p2", name: "Writing", mount: "Writing" },
      { id: "p1", name: "Notes", mount: "Notes" },
    ]);
    expect(toBuildSpec(ws([])).spec.projects).toBeUndefined();
  });

  it("tools don't repeat what the icons install", () => {
    expect(presetWadspace("wad-c")!.advanced.tools).toEqual(["git", "nodejs", "firebase"]);
  });
});
