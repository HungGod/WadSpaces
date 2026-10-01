import { useRef, useState } from "react";
import { motion } from "motion/react";
import { Copy, Minus, Square, X } from "lucide-react";
import clsx from "clsx";
import {
  clampRect,
  inkFor,
  resizeRect,
  snapRect,
  snapZone,
  toFrac,
  toPx,
  type Handle,
  type Rect,
  type Size,
  type SnapState,
} from "./geometry";
import type { Win, WmDispatch } from "./useWindows";
import { localIcon } from "@core/catalog/icons";

const HANDLES: { h: Handle; cls: string }[] = [
  { h: "n", cls: "top-0 left-2 right-2 h-1.5 -translate-y-1/2 cursor-ns-resize" },
  { h: "s", cls: "bottom-0 left-2 right-2 h-1.5 translate-y-1/2 cursor-ns-resize" },
  { h: "e", cls: "right-0 top-2 bottom-2 w-1.5 translate-x-1/2 cursor-ew-resize" },
  { h: "w", cls: "left-0 top-2 bottom-2 w-1.5 -translate-x-1/2 cursor-ew-resize" },
  { h: "ne", cls: "right-0 top-0 size-3 translate-x-1/2 -translate-y-1/2 cursor-nesw-resize" },
  { h: "sw", cls: "left-0 bottom-0 size-3 -translate-x-1/2 translate-y-1/2 cursor-nesw-resize" },
  { h: "nw", cls: "left-0 top-0 size-3 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize" },
  { h: "se", cls: "right-0 bottom-0 size-3 translate-x-1/2 translate-y-1/2 cursor-nwse-resize" },
];

interface Props {
  win: Win;
  area: Size;
  areaEl: React.RefObject<HTMLDivElement | null>;
  active: boolean;
  dispatch: WmDispatch;
  onSnapPreview: (zone: Exclude<SnapState, "normal"> | null) => void;
}

export function Window({ win, area, areaEl, active, dispatch, onSnapPreview }: Props) {
  const [interacting, setInteracting] = useState(false);
  const drag = useRef<{ px: number; py: number; rect: Rect; state: SnapState; zone: ReturnType<typeof snapZone> } | null>(null);

  const shown: Rect = toPx(win.state === "normal" ? win.rect : snapRect(win.state), area);
  const r = clampRect(shown, area);
  const ink = inkFor(win.color);

  const local = (e: React.PointerEvent) => {
    const b = areaEl.current!.getBoundingClientRect();
    return { x: e.clientX - b.left, y: e.clientY - b.top };
  };

  // ---- Move (title bar) ----
  const onTitleDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    dispatch({ type: "focus", id: win.id });
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { px: e.clientX, py: e.clientY, rect: r, state: win.state, zone: null };
  };

  const onTitleMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    let dx = e.clientX - d.px;
    let dy = e.clientY - d.py;
    if (!interacting) {
      if (Math.hypot(dx, dy) < 4) return;
      setInteracting(true);
    }
    // Dragging a snapped/maximized window pops it back to its normal size under the cursor.
    if (d.state !== "normal") {
      const normal = toPx(win.rect, area);
      const grab = (d.px - areaEl.current!.getBoundingClientRect().left - d.rect.x) / d.rect.w;
      const p = local(e);
      d.rect = clampRect({ ...normal, x: p.x - normal.w * grab, y: Math.max(0, p.y - 16) }, area);
      d.state = "normal";
      d.px = e.clientX;
      d.py = e.clientY;
      dx = dy = 0;
    }
    const next = clampRect({ ...d.rect, x: d.rect.x + dx, y: d.rect.y + dy }, area);
    const p = local(e);
    d.zone = snapZone(p.x, p.y, area);
    onSnapPreview(d.zone);
    dispatch({ type: "setRect", id: win.id, rect: toFrac(next, area), state: "normal" });
  };

  const onTitleUp = () => {
    const d = drag.current;
    drag.current = null;
    setInteracting(false);
    onSnapPreview(null);
    if (d?.zone) dispatch({ type: "setState", id: win.id, state: d.zone });
  };

  // ---- Resize (edge + corner handles) ----
  const onHandleDown = (handle: Handle) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    dispatch({ type: "focus", id: win.id });
    e.currentTarget.setPointerCapture(e.pointerId);
    setInteracting(true);
    // Resizing a half-snapped window turns its current shape into the normal rect.
    if (win.state !== "normal") dispatch({ type: "setRect", id: win.id, rect: toFrac(r, area), state: "normal" });
    const start = r;
    const sx = e.clientX;
    const sy = e.clientY;
    const el = e.currentTarget as HTMLElement;
    const move = (ev: PointerEvent) => {
      const next = resizeRect(start, handle, ev.clientX - sx, ev.clientY - sy, area);
      dispatch({ type: "setRect", id: win.id, rect: toFrac(next, area), state: "normal" });
    };
    const up = () => {
      setInteracting(false);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  const maxed = win.state === "max";

  return (
    <motion.div
      role="dialog"
      aria-label={win.title}
      initial={{ opacity: 0, scale: 0.94, y: 12 }}
      animate={win.minimized ? { opacity: 0, scale: 0.6, y: area.h * 0.5 } : { opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.94, transition: { duration: 0.12 } }}
      transition={{ type: "spring", stiffness: 520, damping: 38, mass: 0.7 }}
      onPointerDown={() => dispatch({ type: "focus", id: win.id })}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      className={clsx(
        "absolute flex flex-col overflow-visible",
        !interacting && "transition-[left,top,width,height] duration-200 ease-out",
        win.minimized && "pointer-events-none",
      )}
      style={{ left: r.x, top: r.y, width: r.w, height: r.h, zIndex: win.z }}
    >
      <div
        className={clsx(
          "relative flex h-full flex-col overflow-hidden border transition-shadow",
          maxed ? "rounded-none" : "rounded-xl",
          active ? "border-white/25 shadow-[0_24px_60px_-12px_rgba(0,0,0,0.65)]" : "border-white/10 shadow-[0_12px_32px_-12px_rgba(0,0,0,0.5)]",
        )}
        style={{ background: win.color }}
      >
        {/* Title bar */}
        <div
          onPointerDown={onTitleDown}
          onPointerMove={onTitleMove}
          onPointerUp={onTitleUp}
          onPointerCancel={onTitleUp}
          onDoubleClick={(e) => !(e.target as HTMLElement).closest("button") && dispatch({ type: "toggleMax", id: win.id })}
          className={clsx("flex h-9 shrink-0 select-none items-center gap-2 pl-3 pr-1 touch-none", interacting ? "cursor-grabbing" : "cursor-default")}
          style={{ background: `color-mix(in oklab, ${win.color} 70%, #000)`, color: ink, opacity: active ? 1 : 0.85 }}
        >
          <img src={localIcon(win.iconUrl)} alt="" className="size-4 rounded-sm" draggable={false} />
          <span className="truncate text-[13px] font-medium">{win.title}</span>
          <div className="ml-auto flex items-center">
            <TitleButton label="Minimize" onClick={() => dispatch({ type: "minimize", id: win.id })}>
              <Minus className="size-3.5" />
            </TitleButton>
            <TitleButton label={maxed ? "Restore" : "Maximize"} onClick={() => dispatch({ type: "toggleMax", id: win.id })}>
              {maxed ? <Copy className="size-3 -scale-x-100" /> : <Square className="size-3" />}
            </TitleButton>
            <TitleButton label="Close" danger onClick={() => dispatch({ type: "close", id: win.id })}>
              <X className="size-3.5" />
            </TitleButton>
          </div>
        </div>

        {/* Body: a color-coded placeholder with the app name centered */}
        <div
          className="relative grid flex-1 place-items-center overflow-hidden"
          style={{ color: ink, backgroundImage: "radial-gradient(120% 80% at 50% 0%, rgb(255 255 255 / 0.10), transparent 60%)" }}
        >
          <div className="pointer-events-none flex flex-col items-center gap-3 px-4 text-center">
            <img src={localIcon(win.iconUrl)} alt="" className="size-12 rounded-xl bg-white/15 p-2 shadow-lg" draggable={false} />
            <span className="font-display text-2xl font-semibold tracking-tight">{win.title}</span>
            <span className="text-xs opacity-60">
              {Math.round(r.w)} × {Math.round(r.h)}
            </span>
          </div>
        </div>
      </div>

      {!maxed && !win.minimized && HANDLES.map(({ h, cls }) => (
        <div key={h} onPointerDown={onHandleDown(h)} className={clsx("absolute z-10 touch-none", cls)} />
      ))}
    </motion.div>
  );
}

function TitleButton({ label, danger, onClick, children }: { label: string; danger?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={clsx(
        "grid h-7 w-9 place-items-center rounded-md transition-colors",
        danger ? "hover:bg-[#e81123] hover:text-white" : "hover:bg-white/15",
      )}
    >
      {children}
    </button>
  );
}
