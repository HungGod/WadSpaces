import { describe, expect, it } from "vitest";
import { nextSetupStep, type SetupState } from "./setup";

const base: SetupState = { online: true, signedIn: true, uid: "u1", ownerUid: "u1", github: true, githubSkipped: false };

describe("nextSetupStep", () => {
  it.each<[string, Partial<SetupState>, string]>([
    ["offline and signed out: Wi-Fi first", { online: false, signedIn: false, uid: null }, "wifi"],
    ["online and signed out: sign in", { signedIn: false, uid: null }, "signin"],
    ["signed in, machine not linked", { ownerUid: null }, "link"],
    ["linked to someone else", { ownerUid: "u2" }, "relink"],
    ["linked, no GitHub", { github: false }, "github"],
    ["GitHub skipped", { github: false, githubSkipped: true }, "done"],
    ["all set", {}, "done"],
    ["all set and offline (a reboot without Wi-Fi)", { online: false }, "done"],
    ["signed in offline, not linked: link asks for Wi-Fi itself", { online: false, ownerUid: null }, "link"],
  ])("%s", (_, patch, want) => {
    expect(nextSetupStep({ ...base, ...patch })).toBe(want);
  });
});
