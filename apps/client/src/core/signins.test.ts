// Where saved sign-ins keep their files, as the core says.
import { describe, expect, it } from "vitest";
import { signInPaths } from "./signins";

describe("saved sign-ins", () => {
  it("knows where each kind keeps its files", () => {
    expect(signInPaths("vscode-claude-code")).toEqual([".claude/", ".claude.json"]);
    expect(signInPaths("terminal")).toBeNull();
  });
});
