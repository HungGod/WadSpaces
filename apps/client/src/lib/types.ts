// The app's view of the world. The backends (src/data) produce these: the
// offline one from wadd on this machine, the online one from Firestore and
// the machines' relay heartbeats. The Builder's documents are core/layers'.
export type { Wallpaper } from "@core/layers";

export interface PublicUser {
  /** The key used everywhere in the UI (owner, sharedWith, run history). */
  username: string;
  displayName: string;
  color: string;
  photoURL?: string;
  /** False until the new-user tutorial has been finished or skipped. */
  onboarded: boolean;
  /** What the user launched most recently, so Home can jump straight back into it. */
  lastSession?: LastSession;
}

/** The last container configuration a user started. */
export interface LastSession {
  kind: "wadspace" | "focus";
  wadspaceIds: string[];
  machineId: string;
  /** Focus sessions only: how long the lock ran for. */
  minutes?: number;
  at: string;
}

/** Where a wadspace is on a machine. */
export type ContainerPhase = "idle" | "starting" | "waiting" | "ready" | "stopping" | "error";

export interface Container {
  id: string;
  wadspaceId: string;
  status: "running" | "stopped";
  mode: "local" | "stream";
  startedAt: string;
  /** Finer state from wadd, when known. */
  phase?: ContainerPhase;
  error?: string | null;
  /** On screen on the machine right now. */
  onScreen?: boolean;
  hotkey?: number | null;
  /** Draws on the machine's screen (a lean image). */
  native?: boolean;
}

/** One stretch of a container being up: when, where, who ran it, and who looked in. */
export interface ContainerRun {
  id: string;
  containerId?: string;
  wadspaceId: string;
  /** Kept so history still reads right after a wadspace is renamed or deleted. */
  wadspaceName: string;
  machineId: string;
  /** Who started it. */
  user: string;
  mode: "local" | "stream";
  startedAt: string;
  /** Null while it's still running. */
  endedAt: string | null;
  /** Ids of the projects it mounted. */
  projects?: string[];
}

export interface Machine {
  id: string;
  name: string;
  label: string;
  os: string;
  status: "online" | "offline";
  /** Linked to an account (offline: this machine is enrolled). */
  linked: boolean;
  /** Load in percent; null until the machine reports it. */
  cpu: number | null;
  ram: number | null;
  gpu: string;
  ip: string;
  containers: Container[];
  version?: string;
  lastSeen?: string | null;
  /** On the user's tailnet (Tailscale), when the machine has it. */
  tailnet?: MachineTailnet | null;
}

/** A machine's place on the tailnet, from its heartbeat (or wadd, offline). */
export interface MachineTailnet {
  online: boolean;
  ip: string | null;
  dnsName: string | null;
}

/** wadd's GET /api/tailnet (wadd/tailnet.py): Tailscale on this machine. */
export interface TailnetStatus {
  installed: boolean;
  running?: boolean;
  backendState?: string | null;
  online?: boolean;
  loggedIn?: boolean;
  ip?: string | null;
  dnsName?: string | null;
  stableId?: string | null;
  hostName?: string | null;
  loginName?: string | null;
}

export interface FocusLock {
  wadspaceIds: string[];
  startedAt: number;
  endsAt: number;
}
