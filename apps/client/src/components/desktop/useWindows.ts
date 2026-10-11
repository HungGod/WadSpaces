// Open windows, as labwc and selkies-desktop's taskbar handle them: every
// window is maximized with no title bar (labwc-rc.xml), so all there is to a
// window is whether it's minimized and which one has focus. The taskbar lists
// the newest first.
import { useReducer } from "react";

export interface Win {
  id: string;
  /** What opened it: a desktop icon's id or a Start menu app's key. Opening it again focuses this window. */
  key: string;
  title: string;
  iconUrl: string;
  minimized: boolean;
}

export interface WinSource {
  key: string;
  title: string;
  iconUrl: string;
}

type Action =
  | { type: "open"; app: WinSource }
  | { type: "taskbar"; id: string }
  | { type: "close"; id: string }
  | { type: "closeKey"; key: string }
  | { type: "sync"; app: WinSource };

interface WmState {
  /** Newest first, as the taskbar draws them. */
  wins: Win[];
  /** Window ids, the focused one last. */
  stack: string[];
  seq: number;
}

/** The focused window: the last focused one that isn't minimized. */
export function activeWin(s: Pick<WmState, "wins" | "stack">): Win | null {
  for (let i = s.stack.length - 1; i >= 0; i--) {
    const w = s.wins.find((x) => x.id === s.stack[i]);
    if (w && !w.minimized) return w;
  }
  return null;
}

const raise = (stack: string[], id: string) => [...stack.filter((x) => x !== id), id];

function reducer(s: WmState, a: Action): WmState {
  const set = (id: string, patch: Partial<Win>) => s.wins.map((w) => (w.id === id ? { ...w, ...patch } : w));
  switch (a.type) {
    case "open": {
      const existing = s.wins.find((w) => w.key === a.app.key);
      if (existing) return { ...s, wins: set(existing.id, { minimized: false }), stack: raise(s.stack, existing.id) };
      const win: Win = { id: `w${s.seq + 1}`, ...a.app, minimized: false };
      return { wins: [win, ...s.wins], stack: [...s.stack, win.id], seq: s.seq + 1 };
    }
    case "taskbar": {
      // selkies-desktop: the focused window minimizes; a minimized one comes back and takes focus; any other takes focus.
      const w = s.wins.find((x) => x.id === a.id);
      if (!w) return s;
      if (activeWin(s)?.id === w.id) return { ...s, wins: set(w.id, { minimized: true }) };
      return { ...s, wins: set(w.id, { minimized: false }), stack: raise(s.stack, w.id) };
    }
    case "close":
      return { ...s, wins: s.wins.filter((w) => w.id !== a.id), stack: s.stack.filter((x) => x !== a.id) };
    case "closeKey": {
      const gone = new Set(s.wins.filter((w) => w.key === a.key).map((w) => w.id));
      return { ...s, wins: s.wins.filter((w) => !gone.has(w.id)), stack: s.stack.filter((x) => !gone.has(x)) };
    }
    case "sync":
      return { ...s, wins: s.wins.map((w) => (w.key === a.app.key ? { ...w, title: a.app.title, iconUrl: a.app.iconUrl } : w)) };
  }
}

export function useWindows() {
  return useReducer(reducer, { wins: [], stack: [], seq: 0 });
}
export type WmDispatch = React.Dispatch<Action>;
