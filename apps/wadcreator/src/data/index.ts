// The backend for this build. Chosen at build time (VITE_TARGET), and loaded
// before the app renders, so pages can use `backend` directly. The cloud one
// is a separate chunk: the offline app never loads Firebase.
import type { Backend } from "./backend";

export type { Backend, Caps, Topic } from "./backend";

export let backend: Backend;

export async function initBackend(): Promise<Backend> {
  // Inline (not isOnline from target.ts) so the bundler drops the other branch's chunk.
  if (import.meta.env.VITE_TARGET === "online") {
    const { CloudBackend } = await import("./cloud");
    backend = new CloudBackend();
  } else {
    const { LocalBackend } = await import("./local");
    backend = new LocalBackend();
  }
  await backend.init?.().catch(() => {});
  return backend;
}
