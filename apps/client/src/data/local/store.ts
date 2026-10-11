// What the offline app keeps in its own storage (localStorage): the last
// session (Home's Jump back in) and the tutorial flag. The Builder's
// documents live in wadd's library (layers.ts).
import type { LastSession } from "@/lib/types";

// Named for the WadSpaces Client's old name (wadcreator), and kept: renaming them would lose what's stored.
const KEYS = {
  session: "wadcreator.lastSession.v1",
  onboarded: "wadcreator.onboarded.v1",
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
    // No storage (a private window): it's forgotten, which is fine for these.
  }
}

export const lastSession = {
  get: () => read<LastSession | null>(KEYS.session, null),
  set: (s: Omit<LastSession, "at">) => write(KEYS.session, { ...s, at: new Date().toISOString() }),
};

export const onboarded = {
  get: () => read<boolean>(KEYS.onboarded, false),
  set: () => write(KEYS.onboarded, true),
};
