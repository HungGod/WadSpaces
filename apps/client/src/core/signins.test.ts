import { describe, expect, it } from "vitest";
import { toBuildSpec } from "./build";
import { toWaddSpec } from "./spec";
import { WEB, isSignInPath, signInKind, signInPaths } from "./signins";

describe("saved sign-ins", () => {
  it("knows which sign-ins an app can use", () => {
    expect(signInKind({ appId: "github", iconUrl: "" })).toBe(WEB);
    expect(signInKind({ appId: "custom-x", url: "https://tailscale.com", iconUrl: "" })).toBe(WEB);
    expect(signInKind({ appId: "vscode", iconUrl: "" })).toBe("vscode");
    // Chrome windows aren't WadBrowser's.
    expect(signInKind({ appId: "discord", iconUrl: "" })).toBeNull();
    expect(signInPaths("vscode")).toEqual([".config/Code/User/globalStorage/"]);
    expect(signInPaths("terminal")).toBeNull();
    expect(isSignInPath(".config/tool/")).toBe(true);
    expect(isSignInPath("Desktop/x")).toBe(false);
  });

  it("carries a design's sign-ins to wadd", () => {
    const icon = (id: string, appId: string, signIn?: string) => ({ id, appId, label: appId, iconUrl: "", color: "", x: 0, y: 0, signIn });
    const ws = {
      id: "iq",
      name: "IQ",
      description: "",
      layout: { wallpaper: { type: "color" as const, value: "#000" }, icons: [icon("1", "github", "gh-a1"), icon("2", "claude", "gh-a1"), icon("3", "vscode")], grid: true },
      advanced: {} as never,
    };
    const { spec } = toBuildSpec(ws as never);
    expect(spec.signins).toEqual([
      { id: "gh-a1", app: "github", web: true, name: "github" },
      { id: "gh-a1", app: "claude", web: true, name: "claude" },
    ]);
    expect(toWaddSpec(spec).signins).toEqual(spec.signins);
  });
});
