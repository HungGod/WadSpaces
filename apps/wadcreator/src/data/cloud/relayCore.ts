// The relay's pure parts: shared with tests, no Firebase import.

export interface RelayWorkspace {
  id: string;
  name: string;
  port: number | null;
  hotkey: number | null;
  container: string;
  phase: string;
  error: string | null;
  /** "host" (on the machine's screen) or "stream" (the old all-in-one images). */
  display?: "host" | "stream";
}

// The heartbeat comes every 30 s; a minute and a half of silence means offline.
export const ONLINE_WITHIN_MS = 90_000;

export function isOnlineNow(m: { lastSeen: Date | null }): boolean {
  return !!m.lastSeen && Date.now() - m.lastSeen.getTime() < ONLINE_WITHIN_MS;
}

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I

export function newEnrollCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => CODE_CHARS[b % CODE_CHARS.length]).join("");
}
