// The backend for this build. Chosen at build time (VITE_TARGET, see
// lib/machine.ts), and loaded before the app renders, so pages can use
// `backend` directly. Each is a separate chunk: the offline app never loads
// Firebase.
import type { Backend } from "./backend";

export type { Backend, Caps, Topic } from "./backend";

export let backend: Backend;

/** Tests: the app on a backend of their own (test/fakeBackend.ts). */
export function setBackendForTests(b: Backend) {
  backend = b;
}

export async function initBackend(): Promise<Backend> {
  // Checked inline so the bundler drops the other branch's chunk.
  if (import.meta.env.VITE_TARGET === "online") {
    const { CloudBackend } = await import("./cloud");
    backend = new CloudBackend();
  } else if (import.meta.env.VITE_TARGET === "machine") {
    // Before Firebase loads: a new boot starts signed out.
    await (await import("./machine/boot")).forgetSignInAfterReboot();
    const { MachineBackend } = await import("./machine");
    backend = new MachineBackend();
  } else if (import.meta.env.DEV && import.meta.env.VITE_TARGET === "fake") {
    // `npm run dev:fake`: the tests' fake backend, in a browser, with the
    // sample library (or none: ?empty). Nothing is built or launched.
    const { FakeBackend } = await import("../test/fakeBackend");
    const { sampleBackend } = await import("../test/sample");
    const fake = new URLSearchParams(location.search).has("empty") ? new FakeBackend() : sampleBackend();
    // A machine to look at: Cosmic installed and running, its disk use.
    fake.thisMachine = true;
    for (const w of fake.wadspaces.values()) if (w.version === 3 && w.id === "cosmic-bodybuilding") (fake.installed.set(w.id, w), fake.running.add(w.id));
    fake.sizes = { ...fake.sizes, layers: { "template:writing": 1.65e9, "template:dev": 2.4e9, "custom:vanua-academy-dev": 0.25e9 }, homes: { "cosmic-bodybuilding": 0.9e9 }, copies: { "copy-photos": 0.3e9 }, leftovers: [{ layer: "template:dev", id: "img-dev-old", from: "base", bytes: 5.5e9, ownBytes: 2.3e9 }] };
    // ?update: a newer base than the templates were built on.
    if (new URLSearchParams(location.search).has("update"))
      fake.images.set("base" as never, { layer: "base" as never, ref: "localhost/wadspaces-base:trixie", id: "base-2", dockerfileSha: "", builtAt: 0, sizeMb: 3100, from: "" });
    backend = fake;
  } else {
    const { LocalBackend } = await import("./local");
    backend = new LocalBackend();
  }
  await backend.init?.().catch(() => {});
  return backend;
}
