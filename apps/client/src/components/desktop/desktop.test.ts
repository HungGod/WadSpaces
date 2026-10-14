// The desktop's geometry against selkies-desktop's own: where icons fall,
// how the Start menu and the taskbar's buttons are sized.
import { describe, expect, it } from "vitest";
import { appListOffset, cellAt, rowsFor, taskButtonWidth } from "./geometry";

describe("icon placement (selkies-desktop get_desktop_cell)", () => {
  it("fills a column above the panel, then the next", () => {
    // 1080 tall: (1080 - 56) / 104 = 9 rows.
    expect(rowsFor(1080)).toBe(9);
    expect(cellAt(0, 1080)).toEqual({ x: 10, y: 10 });
    expect(cellAt(8, 1080)).toEqual({ x: 10, y: 842 });
    expect(cellAt(9, 1080)).toEqual({ x: 106, y: 10 });
    // A shorter screen wraps sooner.
    expect(rowsFor(800)).toBe(7);
    expect(cellAt(7, 800)).toEqual({ x: 106, y: 10 });
  });

  it("sizes taskbar buttons like the panel does", () => {
    expect(taskButtonWidth(1920, 0)).toBe(150);
    expect(taskButtonWidth(1920, 3)).toBe(150);
    // (1000 - 60 - 5 - 20 * 5) / 20, and never under the icon and its margin (24 + 10).
    expect(taskButtonWidth(1000, 20)).toBe(41);
    expect(taskButtonWidth(400, 100)).toBe(34);
  });

  it("puts the app list beside the hovered category, kept on screen", () => {
    const { catH, appH, fromBottom } = appListOffset(5, 0, 3);
    expect(catH).toBe(160);
    expect(appH).toBe(100);
    expect(fromBottom).toBe(190);
    // Never lower than the list is tall.
    expect(appListOffset(5, 4, 3).fromBottom).toBe(100);
  });
});
