// This machine's wadd, live, for the machine app's own screens (setup, the
// HUD's menus, the switcher): one subscription to wadd's events, shared.
import { useEffect, useState } from "react";
import { waddEvents, type Snapshot } from "@/lib/wadd";

type Listener = (event: string, data: unknown) => void;
const listeners = new Set<Listener>();
let last: Snapshot | null = null;
let started = false;

function start() {
  if (started) return;
  started = true;
  waddEvents(
    (event, data) => {
      if (event === "state") last = data as Snapshot;
      listeners.forEach((fn) => fn(event, data));
    },
    () => listeners.forEach((fn) => fn("disconnected", null)),
  );
}

/** Every wadd event (`state`, `panel`, `carousel`, `notice`, …). */
export function useWaddEvent(fn: Listener) {
  useEffect(() => {
    start();
    listeners.add(fn);
    return () => void listeners.delete(fn);
  }, [fn]);
}

/** wadd's latest snapshot (null until the first one). */
export function useWaddState(): Snapshot | null {
  const [snap, setSnap] = useState<Snapshot | null>(last);
  useEffect(() => {
    start();
    const fn: Listener = (event, data) => event === "state" && setSnap(data as Snapshot);
    listeners.add(fn);
    if (last) setSnap(last);
    return () => void listeners.delete(fn);
  }, []);
  return snap;
}

export const isOnline = (s: Snapshot | null) => s?.network?.connectivity === "full";
