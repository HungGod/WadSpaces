// The move onto the layers (migrate.ts), against the fake backend: the
// presets and a design from before become templates, customizations and
// version 2 wadspaces; an installed one keeps its old image; drafts go; a
// second run changes nothing.
import { describe, expect, it } from "vitest";
import { presetWadspace } from "@core/presets";
import type { Wadspace } from "@/lib/types";
import { FakeBackend } from "@/test/fakeBackend";
import { migrateToLayers } from "./migrate";

const old = (id: string, extra: Partial<Wadspace> = {}): Wadspace => ({
  ...presetWadspace(id)!,
  owner: "local",
  visibility: "private",
  sharedWith: [],
  local: true,
  sizeMB: 0,
  updatedAt: "2026-09-01T00:00:00.000Z",
  ...extra,
});

describe("moving onto the layers", () => {
  it("makes templates (Writing reused), customizations and v2 wadspaces, keeping old images where installed", async () => {
    const b = new FakeBackend();
    await b.createStarters();
    b.old = [
      old("writing", { installed: true }),
      old("vanua-academy", { installed: true, advanced: { ...presetWadspace("vanua-academy")!.advanced, image: "ghcr.io/hunggod/wadspaces-vanua-academy:latest" } }),
      // With Spotify, a Chrome web app from before (WadBrowser's now).
      old("kale-b", {
        layout: {
          ...presetWadspace("kale-b")!.layout,
          icons: [...presetWadspace("kale-b")!.layout.icons, { id: "sp", appId: "spotify", label: "Spotify", iconUrl: "", color: "#000", x: 0, y: 0, cell: { col: 1, row: 0 } }],
        },
      }),
      { ...old("iq-dev"), id: "throwaway-ab12cd", templateId: "game-dev" },
      { ...old("wad-c"), id: "terminal", app: true },
    ];
    b.drafts = [{ id: "d1", owner: "local", name: "Draft", description: "", visibility: "private", layout: old("writing").layout, step: "apps", updatedAt: "t" }];
    const r = await migrateToLayers(b, "local", "2026-10-11T00:00:00.000Z");
    expect(r.migrated).toEqual(["writing", "vanua-academy", "kale-b", "throwaway-ab12cd"]);
    expect(r.drafts).toBe(1);
    expect(b.drafts).toEqual([]);
    const w = b.wadspaces.get("writing")!;
    // Writing has only Obsidian: the starter Writing template is reused.
    expect(w.base).toEqual({ kind: "template", id: "writing" });
    expect(w.legacyImage).toBe("localhost/wadspaces-writing:latest");
    expect(w.wallpaper.value).toBe("/wallpapers/cosmic-bodybuilding.png");
    const va = b.wadspaces.get("vanua-academy")!;
    expect(va.legacyImage).toBe("ghcr.io/hunggod/wadspaces-vanua-academy:latest");
    expect(va.base.kind).toBe("customization");
    const c = b.customizations.get(va.base.id)!;
    expect(c.name).toBe("Vanua Academy setup");
    expect(c.webapps.map((x) => x.name)).toContain("Gmail");
    expect(b.templates.get(c.templateId)!.apps).toContain("vscode");
    // Not installed here: no old image, it builds on its layers.
    expect(b.wadspaces.get("kale-b")!.legacyImage).toBeUndefined();
    // An old Quick Launch copy: deleted, softly. The machine's own apps aren't wadspaces.
    expect(b.wadspaces.get("throwaway-ab12cd")!.deletedAt).toBe("2026-10-11T00:00:00.000Z");
    expect(b.wadspaces.has("terminal")).toBe(false);
    // Chrome web apps are WadBrowser's now: said once.
    expect(r.notices).toEqual(["Spotify opens in WadBrowser now, which can't do video calls or play DRM video."]);
    // Again: nothing more.
    const again = await migrateToLayers(b, "local");
    expect(again.migrated).toEqual([]);
    expect(b.wadspaces.size).toBe(4);
  });
});
