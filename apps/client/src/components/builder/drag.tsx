// Dragging, on pointer events: a grabbed thing follows the pointer as a
// ghost, drop targets light up green (fits) or red (doesn't, and why), and a
// drop that lands nowhere snaps back to where it came from.
//
// Dropping a module on another stack copies it. Right-click (or Esc) while
// dragging cancels: it snaps back.
// A drag takes the module grabbed and the ones on top of it; with Shift,
// just the module grabbed (the grabber reads e.shiftKey).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AnySub, Module, WebApp } from "./model";
import type { ModuleSource, SubSource } from "./store";

export type Payload =
  | { type: "modules"; modules: Module[]; from: ModuleSource }
  | { type: "sub"; sub: AnySub; from: SubSource }
  /** A catalog app (template editor); `at` when it's already on the desktop. */
  | { type: "app"; appId: string; at?: number }
  /** One thing an app is set up with (Extensions editor). */
  | { type: "item"; item: Item }
  /** WadBrowser apps (one, or several Ctrl+clicked), moving between key groups (Customization editor). */
  | { type: "member"; members: string[]; group: string };

export type Item = { kind: "webapp"; webapp: WebApp } | { kind: "extension"; id: string } | { kind: "tool"; id: string };

export interface Verdict {
  ok: boolean;
  /** What a drop does ("Move to VanuaAcademy") or why it can't. */
  why?: string;
}

export interface DropTarget {
  /** null: not interested, so a target underneath gets a say. */
  accepts(p: Payload, mods: Mods): Verdict | null;
  onDrop(p: Payload, mods: Mods): void;
}

export interface Mods {
  /** Alt is held: move rather than copy. */
  move: boolean;
}

interface Active {
  payload: Payload;
  ghost: ReactNode;
  /** The grabbed element's box, to snap back to. */
  origin: DOMRect;
  /** Where in the element it was grabbed. */
  grab: { x: number; y: number };
}

interface Hover {
  id: string;
  verdict: Verdict;
}

interface Ctx {
  active: Active | null;
  /** Alt is held. */
  move: boolean;
  hover: Hover | null;
  register(id: string, t: DropTarget | null): void;
  begin(a: Active, x: number, y: number): void;
  /** Asks the target under the pointer again (it changed its mind without the pointer moving). */
  refresh(): void;
}

const DragCtx = createContext<Ctx | null>(null);

export function useDrag() {
  const c = useContext(DragCtx);
  if (!c) throw new Error("useDrag outside DragProvider");
  return c;
}

/** Makes an element draggable. `make` runs at grab time (it can read Shift). */
export function useDraggable(make: (e: React.PointerEvent) => { payload: Payload; ghost: ReactNode } | null) {
  const { begin } = useDrag();
  const makeRef = useRef(make);
  makeRef.current = make;

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      if ((e.target as HTMLElement).closest("button, input, textarea, select, a, [data-nodrag]")) return;
      e.stopPropagation();
      const el = e.currentTarget;
      const x0 = e.clientX;
      const y0 = e.clientY;
      const start = e;
      const move = (ev: PointerEvent) => {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return;
        cleanup();
        const made = makeRef.current(start);
        if (!made) return;
        const origin = el.getBoundingClientRect();
        begin({ ...made, origin, grab: { x: x0 - origin.left, y: y0 - origin.top } }, ev.clientX, ev.clientY);
      };
      const cleanup = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", cleanup);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", cleanup);
    },
    [begin],
  );
  return { onPointerDown };
}

/** Makes an element a drop target; returns its props and whether something hovers it. */
export function useDropTarget(id: string, target: DropTarget) {
  const { register, hover, active } = useDrag();
  const ref = useRef(target);
  ref.current = target;
  useEffect(() => {
    register(id, { accepts: (p, m) => ref.current.accepts(p, m), onDrop: (p, m) => ref.current.onDrop(p, m) });
    return () => register(id, null);
  }, [id, register]);
  const over = hover?.id === id ? hover.verdict : null;
  // Whether what's being dragged could go here at all, to light up while dragging.
  const could = active ? !!target.accepts(active.payload, { move: false })?.ok : false;
  return { props: { "data-drop": id }, over, could, dragging: !!active };
}

export function DragProvider({ children }: { children: ReactNode }) {
  const targets = useRef(new Map<string, DropTarget>());
  const [active, setActive] = useState<Active | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [move, setMove] = useState(false);
  const [returning, setReturning] = useState(false);
  const activeRef = useRef<Active | null>(null);
  const hoverRef = useRef<Hover | null>(null);
  const pointer = useRef({ x: 0, y: 0 });
  const updateRef = useRef<(() => void) | null>(null);
  const refresh = useCallback(() => updateRef.current?.(), []);

  const register = useCallback((id: string, t: DropTarget | null) => {
    if (t) targets.current.set(id, t);
    else targets.current.delete(id);
  }, []);

  const find = useCallback((x: number, y: number, mods: Mods): Hover | null => {
    const a = activeRef.current;
    if (!a) return null;
    for (const el of document.elementsFromPoint(x, y)) {
      const id = (el as HTMLElement).dataset?.drop;
      const t = id ? targets.current.get(id) : undefined;
      const verdict = id && t ? t.accepts(a.payload, mods) : null;
      if (id && verdict) return { id, verdict };
    }
    return null;
  }, []);

  const begin = useCallback(
    (a: Active, x: number, y: number) => {
      activeRef.current = a;
      pointer.current = { x, y };
      setActive(a);
      setPos({ x, y });
      setReturning(false);
      document.body.classList.add("is-dragging");

      let moveNow = false;
      const update = () => {
        const h = find(pointer.current.x, pointer.current.y, { move: moveNow });
        hoverRef.current = h;
        setHover(h);
      };
      updateRef.current = update;
      const onMove = (e: PointerEvent) => {
        pointer.current = { x: e.clientX, y: e.clientY };
        setPos({ x: e.clientX, y: e.clientY });
        update();
      };
      const key = (e: KeyboardEvent) => {
        if (e.key === "Escape") finish(false);
      };
      // A right click mid-drag cancels it (and opens no menu, selects nothing).
      const cancel = (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
      };
      const rightDown = (e: PointerEvent) => e.button === 2 && cancel(e);
      // Scrolls whatever's under the pointer when it nears that edge.
      let raf = 0;
      const scroll = () => {
        const { x, y } = pointer.current;
        for (const el of document.querySelectorAll<HTMLElement>("[data-autoscroll]")) {
          const r = el.getBoundingClientRect();
          if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
          const edge = 40;
          if (y > r.bottom - edge) el.scrollTop += 14;
          else if (y < r.top + edge) el.scrollTop -= 14;
          if (x > r.right - edge) el.scrollLeft += 14;
          else if (x < r.left + edge) el.scrollLeft -= 14;
        }
        raf = requestAnimationFrame(scroll);
      };
      raf = requestAnimationFrame(scroll);

      let done = false;
      const finish = (drop: boolean) => {
        if (done) return;
        done = true;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("keydown", key);
        window.removeEventListener("pointerdown", rightDown, true);
        // The menu event comes after pointerdown: keep eating it for a moment.
        setTimeout(() => window.removeEventListener("contextmenu", cancel, true), 0);
        cancelAnimationFrame(raf);
        document.body.classList.remove("is-dragging");
        // The pointerup ends in a click on whatever's under it: swallow it.
        const eat = (e: MouseEvent) => {
          e.stopPropagation();
          e.preventDefault();
        };
        window.addEventListener("click", eat, { capture: true, once: true });
        setTimeout(() => window.removeEventListener("click", eat, { capture: true }), 0);

        const h = hoverRef.current;
        const payload = activeRef.current?.payload;
        const t = h && targets.current.get(h.id);
        if (drop && h?.verdict.ok && t && payload) {
          t.onDrop(payload, { move: moveNow });
          end();
        } else {
          // Snap back to where it came from.
          setReturning(true);
          setHover(null);
          setTimeout(end, 230);
        }
      };
      const up = () => finish(true);
      const end = () => {
        updateRef.current = null;
        activeRef.current = null;
        hoverRef.current = null;
        setActive(null);
        setHover(null);
        setReturning(false);
        setMove(false);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", up);
      window.addEventListener("keydown", key);
      window.addEventListener("pointerdown", rightDown, true);
      window.addEventListener("contextmenu", cancel, true);
      update();
    },
    [find],
  );

  const ctx = useMemo(() => ({ active, move, hover, register, begin, refresh }), [active, move, hover, register, begin, refresh]);

  return (
    <DragCtx.Provider value={ctx}>
      {children}
      {active && (
        <div
          className={`drag-ghost${returning ? " returning" : ""}`}
          style={{
            width: active.origin.width,
            transform: returning
              ? `translate(${active.origin.left}px, ${active.origin.top}px)`
              : `translate(${pos.x - active.grab.x}px, ${pos.y - active.grab.y}px) scale(1.02)`,
          }}
        >
          {active.ghost}
        </div>
      )}
      {active && !returning && (
        // By the pointer, so it's never off screen under a tall ghost.
        <div className={`drag-hint${hover ? (hover.verdict.ok ? " ok" : " no") : ""}`} style={{ transform: `translate(${pos.x + 18}px, ${pos.y - 40}px)` }}>
          {hover?.verdict.why ?? "Drop on a stack to copy it there · right-click to cancel"}
        </div>
      )}
    </DragCtx.Provider>
  );
}
