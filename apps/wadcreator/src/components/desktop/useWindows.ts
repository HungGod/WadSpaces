import { useReducer } from "react";
import type { LayoutIcon } from "@/lib/types";
import type { Rect, SnapState } from "./geometry";

export interface Win {
  id: string;
  iconId: string;
  title: string;
  iconUrl: string;
  color: string;
  /** The "normal" (restored) rect in fractions of the work area. */
  rect: Rect;
  state: SnapState;
  minimized: boolean;
  z: number;
}

type Action =
  | { type: "open"; icon: LayoutIcon }
  | { type: "focus"; id: string }
  | { type: "close"; id: string }
  | { type: "minimize"; id: string }
  | { type: "toggleMax"; id: string }
  | { type: "setRect"; id: string; rect: Rect; state?: SnapState }
  | { type: "setState"; id: string; state: SnapState }
  | { type: "taskbar"; id: string }
  | { type: "syncIcon"; icon: LayoutIcon }
  | { type: "closeIcon"; iconId: string };

interface WmState {
  wins: Win[];
  zTop: number;
  seq: number;
}

/** The topmost window that is not minimized. */
export const activeWin = (wins: Win[]) =>
  wins.filter((w) => !w.minimized).reduce<Win | null>((top, w) => (!top || w.z > top.z ? w : top), null);

function reducer(s: WmState, a: Action): WmState {
  const map = (id: string, fn: (w: Win) => Win) => s.wins.map((w) => (w.id === id ? fn(w) : w));
  switch (a.type) {
    case "open": {
      const existing = s.wins.find((w) => w.iconId === a.icon.id);
      if (existing) return { ...s, zTop: s.zTop + 1, wins: map(existing.id, (w) => ({ ...w, minimized: false, z: s.zTop + 1 })) };
      const n = s.wins.length % 8;
      const win: Win = {
        id: `w${s.seq + 1}`,
        iconId: a.icon.id,
        title: a.icon.label,
        iconUrl: a.icon.iconUrl,
        color: a.icon.color,
        rect: { x: 0.14 + n * 0.035, y: 0.08 + n * 0.045, w: 0.52, h: 0.62 },
        state: "normal",
        minimized: false,
        z: s.zTop + 1,
      };
      return { wins: [...s.wins, win], zTop: s.zTop + 1, seq: s.seq + 1 };
    }
    case "focus":
      if (s.wins.find((w) => w.id === a.id)?.z === s.zTop) return s;
      return { ...s, zTop: s.zTop + 1, wins: map(a.id, (w) => ({ ...w, z: s.zTop + 1, minimized: false })) };
    case "close":
      return { ...s, wins: s.wins.filter((w) => w.id !== a.id) };
    case "closeIcon":
      return { ...s, wins: s.wins.filter((w) => w.iconId !== a.iconId) };
    case "minimize":
      return { ...s, wins: map(a.id, (w) => ({ ...w, minimized: true })) };
    case "toggleMax":
      return { ...s, zTop: s.zTop + 1, wins: map(a.id, (w) => ({ ...w, state: w.state === "max" ? "normal" : "max", z: s.zTop + 1 })) };
    case "setRect":
      return { ...s, wins: map(a.id, (w) => ({ ...w, rect: a.rect, state: a.state ?? w.state })) };
    case "setState":
      return { ...s, wins: map(a.id, (w) => ({ ...w, state: a.state })) };
    case "taskbar": {
      // Windows-style: restore if minimized, minimize if already focused, otherwise focus.
      const w = s.wins.find((x) => x.id === a.id);
      if (!w) return s;
      if (!w.minimized && activeWin(s.wins)?.id === w.id) return { ...s, wins: map(a.id, (x) => ({ ...x, minimized: true })) };
      return { ...s, zTop: s.zTop + 1, wins: map(a.id, (x) => ({ ...x, minimized: false, z: s.zTop + 1 })) };
    }
    case "syncIcon":
      return { ...s, wins: s.wins.map((w) => (w.iconId === a.icon.id ? { ...w, title: a.icon.label, iconUrl: a.icon.iconUrl, color: a.icon.color } : w)) };
  }
}

export function useWindows() {
  return useReducer(reducer, { wins: [], zTop: 10, seq: 0 });
}
export type WmDispatch = React.Dispatch<Action>;
