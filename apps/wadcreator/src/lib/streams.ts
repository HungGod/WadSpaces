// Viewing a wadspace on another device: one of your machines streams it on
// its local network (wadd's streams: TLS with its own certificate, your
// username and the account's stream password), and
// - in the machine app, this machine's wadd opens a view of it (pinning that
//   certificate, adding the password) in a window of its own (stream.rs);
// - online (a browser, a phone on the same network), you open its link,
//   check the certificate's fingerprint and sign in.
import { backend } from "@/data";
import { useApp } from "./store";
import type { Machine, RemoteStream } from "./types";
import { inTauri } from "./shell";

export const MIN_STREAM_PASSWORD = 12;

/** A password that's easy to type on a phone: 4 groups of 5, no look-alikes. */
export function generateStreamPassword(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]);
  return [0, 5, 10, 15].map((i) => chars.slice(i, i + 5).join("")).join("-");
}

/** A certificate's SHA-256 as browsers show it: AB:CD:… */
export function formatFingerprint(sha256: string): string {
  return (sha256.toUpperCase().match(/../g) ?? []).join(":");
}

const machineNow = (id: string) => useApp.getState().machines.find((m) => m.id === id);

/** Waits until a machine reports a stream of this wadspace that's ready. */
export async function waitForStream(machineId: string, wsId: string, timeoutMs = 5 * 60_000): Promise<RemoteStream> {
  const until = Date.now() + timeoutMs;
  let polls = 0;
  while (Date.now() < until) {
    const s = machineNow(machineId)?.streams?.find((x) => x.wsId === wsId && x.ready);
    if (s) return s;
    if (polls++ % 5 === 0) await useApp.getState().loadMachines();
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("It didn't start in time. Look on that machine for why.");
}

/** Asks the machine to stream it (unless it already is) and waits for it.
 *  It's on that machine's screen: asks first whether to take it off. */
export async function ensureStream(m: Machine, ws: { id: string; name: string }, projects: string[] = []) {
  const ready = m.streams?.find((s) => s.wsId === ws.id && s.ready);
  if (ready) return ready;
  if (!backend.requestStream) throw new Error("Viewing other machines isn't possible here.");
  try {
    await backend.requestStream(m.id, ws.id, { projects });
  } catch (e) {
    const msg = (e as Error).message;
    if (!/open on .*screen/.test(msg)) throw e;
    if (!confirm(`${ws.name} is open on ${m.label}'s screen. Take it off there to view it here?`)) throw new Error("Left as it is.");
    await backend.requestStream(m.id, ws.id, { projects, restart: true });
  }
  return waitForStream(m.id, ws.id);
}

/** In the machine app: view it here, in a window over the app. */
export async function viewHere(m: Machine, ws: { id: string; name: string }, projects: string[] = []) {
  if (!inTauri) throw new Error("Only the machine app opens views.");
  const toast = useApp.getState().toast;
  if (!m.streams?.some((s) => s.wsId === ws.id && s.ready)) toast({ title: `Asking ${m.label} to stream it`, body: ws.name });
  await ensureStream(m, ws, projects);
  const { commands } = await import("@/gen/bindings");
  await commands.streamView(m.id, ws.id, `${ws.name} · ${m.label}`);
}
