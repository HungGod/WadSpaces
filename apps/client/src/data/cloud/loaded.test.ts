// The account backend is loaded once each list it watches has answered: a
// list too few (counting 4 for 3, from 10-11) left the machine app waiting
// forever, so after every start it showed no wadspaces and no machines.
import { describe, expect, it, vi } from "vitest";

vi.mock("./firebase", () => ({ auth: {}, db: {} }));
vi.mock("./auth", () => ({
  onAuthUser: (cb: (u: { uid: string } | null) => void) => cb({ uid: "me" }),
  currentAuthUser: async () => ({ uid: "me" }),
  signOut: async () => {},
}));
vi.mock("firebase/firestore", async (original) => {
  const empty = { docs: [], empty: true, size: 0, exists: () => false, data: () => undefined, docChanges: () => [], forEach: () => {} };
  return {
    ...(await original<typeof import("firebase/firestore")>()),
    collection: (...path: unknown[]) => ({ path }),
    doc: (...path: unknown[]) => ({ path }),
    query: (q: unknown) => q,
    where: () => ({}),
    // Every listener answers at once, with nothing.
    onSnapshot: (_q: unknown, next: (s: typeof empty) => void) => {
      setTimeout(() => next(empty));
      return () => {};
    },
  };
});

describe("the account backend", () => {
  it("finishes loading once its lists have answered", async () => {
    const { CloudBackend } = await import("./index");
    const b = new CloudBackend();
    const within = <T,>(p: Promise<T>) => Promise.race([p, new Promise<never>((_, no) => setTimeout(() => no(new Error("still waiting")), 1000))]);
    await expect(within(b.listWadspaces())).resolves.toEqual([]);
    await expect(within(b.listMachines())).resolves.toEqual([]);
  });
});
