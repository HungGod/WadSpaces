import { describe, expect, it } from "vitest";
import { downloadLabel, formatBytes, formatDuration } from "./wadd";

describe("download labels", () => {
  const base = { layers: 7, rate_bps: 0, eta_s: null, unpacking: false };

  it("matches wadd's wording while downloading", () => {
    expect(downloadLabel({ ...base, total_bytes: 5.3e9, done_bytes: 1.9e9, rate_bps: 12e6, eta_s: 283 })).toBe(
      "1.9 GB of 5.3 GB · 12.0 MB/s · about 5 min left",
    );
  });

  it("falls back to the layer count without sizes", () => {
    expect(downloadLabel({ ...base, total_bytes: null, done_bytes: 0 })).toBe("downloading 7 layers");
  });

  it("says when it is unpacking or already there", () => {
    expect(downloadLabel({ ...base, total_bytes: 411e6, done_bytes: 407e6, unpacking: true })).toBe(
      "downloaded 407.0 MB, unpacking",
    );
    expect(downloadLabel({ ...base, total_bytes: 0, done_bytes: 0 })).toBe("already downloaded, unpacking");
    expect(downloadLabel(null)).toBe("");
  });

  it("formats sizes and durations", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(7000)).toBe("7 KB");
    expect(formatBytes(2.5e9)).toBe("2.5 GB");
    expect(formatDuration(30)).toBe("30 s");
    expect(formatDuration(600)).toBe("10 min");
    expect(formatDuration(7200)).toBe("2.0 h");
  });
});
