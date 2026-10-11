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
  } else {
    const { LocalBackend } = await import("./local");
    backend = new LocalBackend();
  }
  await backend.init?.().catch(() => {});
  return backend;
}
