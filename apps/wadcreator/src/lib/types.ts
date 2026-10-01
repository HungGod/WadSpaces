// The app's view of the world. Both backends (src/data) produce these: the
// offline one from wadd on this machine, the online one from Firestore and the
// machines' relay heartbeats. The stored wadspace itself lives in core/model.
import type { WadspaceSpec } from "@core/model";

export type {
  Advanced,
  AgentConfig,
  AgentRuntime,
  Layout,
  LayoutIcon,
  Visibility,
  Wallpaper,
  WadspaceSpec,
} from "@core/model";
import type { Visibility } from "@core/model";

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

export interface Wadspace extends WadspaceSpec {
  owner: string;
  visibility: Visibility;
  sharedWith: string[];
  /** Installed on the launch-target machine with its image present. */
  local: boolean;
  sizeMB: number;
  updatedAt: string;
  /** Set when this is a throwaway copy of a Quick Launch template. */
  templateId?: string;
  /** Installed on the launch-target machine (image may still be missing). */
  installed?: boolean;
  /** Came with the machine (a preset) rather than from the Builder. */
  preset?: boolean;
  /** Online: built on a machine, not in the account; names the machine. */
  machineOnly?: string;
  /** Offline: the projects its unit mounts now (from its last launch). */
  mountedProjects?: string[];
}

/** Builder work that's been saved but not built yet. */
export interface Draft {
  id: string;
  owner: string;
  name: string;
  description: string;
  visibility: Visibility;
  layout: WadspaceSpec["layout"];
  advanced?: WadspaceSpec["advanced"];
  agent?: WadspaceSpec["agent"];
  dockerfile?: string;
  /** Set when the draft holds unbuilt changes to a wadspace that already exists. */
  wadspaceId?: string;
  /** The Builder step it was saved on, so Continue picks up there. */
  step: "apps" | "projects" | "customize";
  updatedAt: string;
}

export interface App {
  id: string;
  name: string;
  domain: string;
  color: string;
  /** Local icon for apps whose website favicon doesn't match (otherwise the Google favicon is used). */
  iconUrl?: string;
}

/** Where a wadspace is on a machine. */
export type ContainerPhase = "idle" | "pulling" | "starting" | "waiting" | "ready" | "stopping" | "error";

export interface Container {
  id: string;
  wadspaceId: string;
  status: "running" | "stopped";
  mode: "local" | "stream";
  startedAt: string;
  /** Finer state from wadd, when known. */
  phase?: ContainerPhase;
  error?: string | null;
  /** 0..1 while the image downloads. */
  download?: { progress: number | null; label: string } | null;
  /** On screen on the machine right now. */
  onScreen?: boolean;
  hotkey?: number | null;
  /** A streamed wadspace served on the machine's tailnet: opens on the user's
   *  devices signed in to the same tailnet, nowhere else. */
  streamUrl?: string | null;
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
  allowRemote: boolean;
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
  /** Streamed wadspaces served on the tailnet. */
  streams: { wsId: string; url: string }[];
}

export interface FocusLock {
  wadspaceIds: string[];
  startedAt: number;
  endsAt: number;
}
