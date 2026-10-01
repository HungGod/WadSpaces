import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tar } from "./tar";

describe("tar", () => {
  it("is a folder GNU tar reads back, directories included", () => {
    const long = `root/usr/share/${"deep/".repeat(20)}file.txt`;
    const bin = new Uint8Array([0, 1, 2, 255]);
    const t = tar([
      { path: "Dockerfile", content: "FROM x\n" },
      { path: "root/etc/wadspaces/layout.json", content: '{"icons":[]}\n' },
      { path: "root/usr/share/backgrounds/wallpaper.png", content: bin },
      { path: long, content: "deep" },
    ]);
    expect(t.length % 512).toBe(0);
    const dir = mkdtempSync(join(tmpdir(), "wadc-tar-"));
    writeFileSync(join(dir, "ctx.tar"), t);
    const listing = execFileSync("tar", ["-tf", join(dir, "ctx.tar")], { encoding: "utf8" }).split("\n");
    expect(listing).toContain("root/etc/wadspaces/");
    expect(listing).toContain(long);
    execFileSync("tar", ["-xf", join(dir, "ctx.tar"), "-C", dir]);
    expect(readFileSync(join(dir, "Dockerfile"), "utf8")).toBe("FROM x\n");
    expect([...readFileSync(join(dir, "root/usr/share/backgrounds/wallpaper.png"))]).toEqual([0, 1, 2, 255]);
    expect(readFileSync(join(dir, long), "utf8")).toBe("deep");
  });

  it("refuses paths that would escape the folder", () => {
    expect(() => tar([{ path: "../x", content: "" }])).toThrow(/bad path/);
    expect(() => tar([{ path: "/etc/passwd", content: "" }])).toThrow(/bad path/);
  });

  it("is deterministic", () => {
    const e = [{ path: "b", content: "2" }, { path: "a", content: "1" }];
    expect(tar(e)).toEqual(tar([...e].reverse()));
  });
});
