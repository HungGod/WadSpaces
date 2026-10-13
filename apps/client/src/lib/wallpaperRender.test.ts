import { describe, expect, it } from "vitest";
import { WALLPAPER_PRESETS } from "@/components/desktop/wallpapers";
import { clearStops, parseStops, radialShape, rgbOf, splitTop } from "./wallpaperRender";

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

  it("every gradient preset parses into layers the renderer knows", () => {
    expect(WALLPAPER_PRESETS.map((p) => p.name)).toEqual(["Aurora", "Nebula", "Acid Dusk", "Neon Tide", "Ember", "Glacier", "Midnight", "Prism", "Haze"]);
    for (const p of WALLPAPER_PRESETS) {
      expect(p.wallpaper.type).toBe("gradient");
      for (const layer of splitTop(p.wallpaper.value)) {
        expect(layer).toMatch(/^(linear-gradient\(|radial-gradient\(|#[0-9a-f]{3,8}$)/i);
        const radial = layer.match(/^radial-gradient\((.*)\)$/s);
        if (radial) {
          const [shape, ...stops] = splitTop(radial[1]);
          expect(radialShape(shape), `${p.name}: ${shape}`).not.toBeNull();
          for (const st of clearStops(parseStops(stops))) expect(rgbOf(st.color), `${p.name}: ${st.color}`).not.toBeNull();
        }
      }
    }
  });

  it("reads a radial shape whose centre is off the canvas", () => {
    expect(radialShape("120% 80% at 50% -5%")).toEqual([1.2, 0.8, 0.5, -0.05]);
    expect(radialShape("closest-side")).toBeNull();
  });

  it("fades to transparent in the neighbouring colour, as CSS does (not through black)", () => {
    expect(rgbOf("rgb(198 255 31 / 0.38)")).toEqual([198, 255, 31]);
    expect(rgbOf("#ff3d8155")).toEqual([255, 61, 129]);
    expect(rgbOf("#abc")).toEqual([170, 187, 204]);
    expect(clearStops(parseStops(["rgb(255 61 129 / 0.5)", "transparent 60%"]))).toEqual([
      { color: "rgb(255 61 129 / 0.5)", at: 0 },
      { color: "rgba(255, 61, 129, 0)", at: 0.6 },
    ]);
    expect(clearStops(parseStops(["transparent", "#0a0614"]))[0].color).toBe("rgba(10, 6, 20, 0)");
  });
});
