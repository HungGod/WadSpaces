// Client for wadd, the switcher daemon on this machine.
//
// For now Wad Creator is served by wadd itself (http://localhost:8081) and
// talks to its API on 127.0.0.1:8080 directly. When Wad Creator moves to
// wadcreator.com this becomes Firestore commands relayed by wadd/cloud.py.

import { useEffect, useState } from "react";
import type { WaddSpec } from "./spec";

export const WADD_URL: string = import.meta.env.VITE_WADD_URL || "http://127.0.0.1:8080";

export interface WorkspaceState {
  container: string;
  phase: "idle" | "pulling" | "starting" | "waiting" | "ready" | "stopping" | "error";
  progress: number | null;
  message: string | null;
  error: string | null;
  since: number;
}

export interface MachineWorkspace {
  id: string;
  name: string;
  port: number;
  url: string;
  hotkey: number | null;
  icon: string | null;
  enabled: boolean;
  image: string;
  state: WorkspaceState;
}

export interface Snapshot {
  machine: string;
  version: string;
  view: string;
  kiosk_connected: boolean;
  backend: string;
  backend_connected: boolean;
  hotkey_devices: number;
  workspaces: MachineWorkspace[];
}

export class WaddError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`${WADD_URL}${path}`, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new WaddError(`Cannot reach wadd at ${WADD_URL}. Is this a WadSpaces machine?`, 0);
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const detail = (data as { detail?: unknown }).detail;
    throw new WaddError(typeof detail === "string" ? detail : r.statusText, r.status);
  }
  return data as T;
}

export const wadd = {
  status: () => call<Omit<Snapshot, "workspaces">>("GET", "/api/status"),
  workspaces: () => call<MachineWorkspace[]>("GET", "/api/workspaces"),
  specs: () => call<WaddSpec[]>("GET", "/api/specs"),
  spec: (id: string) => call<WaddSpec>("GET", `/api/specs/${encodeURIComponent(id)}`),
  action: (id: string, action: "switch" | "start" | "stop" | "restart") =>
    call<{ ok: boolean }>("POST", `/api/workspaces/${encodeURIComponent(id)}/${action}`),
  launcher: () => call("POST", "/api/launcher"),
  create: (spec: WaddSpec) => call<WaddSpec>("POST", "/api/workspaces", spec),
  update: (id: string, spec: WaddSpec) =>
    call<{ workspace: WaddSpec; restart_required: boolean }>("PUT", `/api/workspaces/${encodeURIComponent(id)}`, spec),
  remove: (id: string) => call("DELETE", `/api/workspaces/${encodeURIComponent(id)}`),
  secrets: () => call<string[]>("GET", "/api/secrets"),
  setSecret: (name: string, value: string) =>
    call("PUT", `/api/secrets/${encodeURIComponent(name)}`, { value }),
  deleteSecret: (name: string) => call("DELETE", `/api/secrets/${encodeURIComponent(name)}`),
};

/** Live machine snapshot from wadd's server-sent events. */
export function useMachine(): { snap: Snapshot | null; error: string | null } {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    const connect = () => {
      es = new EventSource(`${WADD_URL}/api/events`);
      es.addEventListener("state", (e) => {
        setSnap(JSON.parse((e as MessageEvent).data));
        setError(null);
      });
      es.onerror = () => {
        es?.close();
        if (closed) return;
        setError(`Cannot reach wadd at ${WADD_URL}.`);
        retry = setTimeout(connect, 3000);
      };
    };
    connect();
    return () => {
      closed = true;
      es?.close();
      clearTimeout(retry);
    };
  }, []);
  return { snap, error };
}
