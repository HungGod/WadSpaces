import { describe, expect, it } from "vitest";
import { formatBytes, formatDuration } from "./wadd";

describe("formatting", () => {
  it("formats sizes and durations", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(7000)).toBe("7 KB");
    expect(formatBytes(2.5e9)).toBe("2.5 GB");
    expect(formatDuration(30)).toBe("30 s");
    expect(formatDuration(600)).toBe("10 min");
    expect(formatDuration(7200)).toBe("2.0 h");
  });
});
