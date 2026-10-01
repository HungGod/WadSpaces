import { describe, expect, it } from "vitest";
import { WALLPAPER_PRESETS } from "@/components/desktop/wallpapers";
import { parseStops, splitTop } from "./wallpaperRender";

describe("wallpaper CSS parsing", () => {
  it("splits layers on top-level commas only", () => {
    expect(splitTop("radial-gradient(60% 60% at 30% 30%, #ff3d8166 0%, transparent 60%), #0a0614")).toEqual([
      "radial-gradient(60% 60% at 30% 30%, #ff3d8166 0%, transparent 60%)",
      "#0a0614",
    ]);
  });

  it("reads stops, spreading unpositioned ones like CSS", () => {
    expect(parseStops(["#000 0%", "#fff 50%"])).toEqual([
      { color: "#000", at: 0 },
      { color: "#fff", at: 0.5 },
    ]);
    expect(parseStops(["red", "green", "blue"])).toEqual([
      { color: "red", at: 0 },
      { color: "green", at: 0.5 },
      { color: "blue", at: 1 },
    ]);
    expect(parseStops(["#2a0b2e 0%", "#7a1f3d 55%", "#ff8a3d 120%"]).at(-1)).toEqual({ color: "#ff8a3d", at: 1.2 });
  });

  it("every preset parses into layers the renderer knows", () => {
    for (const p of WALLPAPER_PRESETS) {
      for (const layer of splitTop(p.wallpaper.value)) {
        expect(layer).toMatch(/^(linear-gradient\(|radial-gradient\(\d|#[0-9a-f]{3,8}$)/i);
      }
    }
  });
});
