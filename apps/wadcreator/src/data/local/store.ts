// What the offline app keeps in its own storage (localStorage): the last
// session, the tutorial flag, and which presets' default projects it has made.
// The Builder library and drafts live in wadd (library.ts); these copies are
// only used with an older wadd, and moved into wadd once it has a library.
import type { Visibility, WadspaceSpec } from "@core/model";
import type { Draft, LastSession } from "@/lib/types";

export interface LibraryEntry {
  spec: WadspaceSpec;
  visibility: Visibility;
  templateId?: string;
  createdAt: string;
  updatedAt: string;
}

const KEYS = {
  library: "wadcreator.library.v2",
  drafts: "wadcreator.drafts.v1",
  session: "wadcreator.lastSession.v1",
  onboarded: "wadcreator.onboarded.v1",
  presetProjects: "wadcreator.presetProjects.v1",
} as const;

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    throw new Error("Couldn't save on this machine (storage is full). Try a smaller wallpaper.");
  }
}

export const library = {
  all: () => read<Record<string, LibraryEntry>>(KEYS.library, {}),
  get: (id: string) => library.all()[id],
  put(entry: LibraryEntry) {
    write(KEYS.library, { ...library.all(), [entry.spec.id]: entry });
  },
  remove(id: string) {
    const all = library.all();
    delete all[id];
    write(KEYS.library, all);
  },
};

export const drafts = {
  all: () => read<Record<string, Draft>>(KEYS.drafts, {}),
  put(d: Draft) {
    write(KEYS.drafts, { ...drafts.all(), [d.id]: d });
  },
  remove(id: string) {
    const all = drafts.all();
    delete all[id];
    write(KEYS.drafts, all);
  },
};

export const lastSession = {
  get: () => read<LastSession | null>(KEYS.session, null),
  set: (s: Omit<LastSession, "at">) => write(KEYS.session, { ...s, at: new Date().toISOString() }),
};

export const onboarded = {
  get: () => read<boolean>(KEYS.onboarded, false),
  set: () => write(KEYS.onboarded, true),
};

/** Presets whose default projects were made once: a project the user deletes stays deleted. */
export const presetProjectsMade = {
  has: (id: string) => read<string[]>(KEYS.presetProjects, []).includes(id),
  add: (id: string) => write(KEYS.presetProjects, [...new Set([...read<string[]>(KEYS.presetProjects, []), id])]),
};
