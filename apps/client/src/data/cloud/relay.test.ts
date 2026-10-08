import { describe, expect, it } from "vitest";
import { ONLINE_WITHIN_MS, isOnlineNow, newEnrollCode } from "./relayCore";

describe("relay", () => {
  it("makes codes enrollMachine accepts, without look-alike characters", () => {
    for (let i = 0; i < 200; i++) {
      const code = newEnrollCode();
      expect(code).toMatch(/^[A-Z0-9]{6,12}$/); // functions/src/index.ts
      expect(code).not.toMatch(/[01OI]/);
    }
  });

  it("counts a machine online while its heartbeat is recent", () => {
    const base = { id: "m", name: "m", hostname: "", daemonVersion: "", view: null, workspaces: [] };
    expect(isOnlineNow({ ...base, lastSeen: new Date() })).toBe(true);
    expect(isOnlineNow({ ...base, lastSeen: new Date(Date.now() - ONLINE_WITHIN_MS - 1000) })).toBe(false);
    expect(isOnlineNow({ ...base, lastSeen: null })).toBe(false);
  });
});
