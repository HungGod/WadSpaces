// One desktop icon, as selkies-desktop draws it: a 48 px picture over a
// 12 px white label in its fixed cell, a "+" on VS Code when extensions are
// added, and a mark for what opens at boot. Any mouse button is a click.
import { useEffect, useRef } from "react";
import { Plus, Power } from "lucide-react";
import clsx from "clsx";
import { CELL_H, CELL_W, DESKTOP_ICON } from "./geometry";

interface Props {
  label: string;
  iconUrl: string;
  x: number;
  y: number;
  /** selkies-desktop's highlight after a single click. */
  selected?: boolean;
  renaming?: boolean;
  /** Builder only: opens on startup (the image shows no marker). */
  startup?: boolean;
  /** Builder only: on the design but not on the image's desktop; says why. */
  ghost?: string;
  /** Mock images only: a + on the picture, for an app with things added (VS Code's extensions). */
  added?: number;
  onRename?: (label: string | null) => void;
  onPointerDown?: (e: React.PointerEvent) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}

/**
 * One desktop icon as selkies-desktop draws it (ui.c draw_bg): the picture at
 * 48px, centred 5px from the top of a 96×104 cell, and the name in white
 * 12px sans-serif under it, on up to two lines. No tile behind the picture,
 * no hover, no text shadow.
 */
export function DesktopIcon({ label, iconUrl, x, y, selected, renaming, startup, ghost, added, onRename, onPointerDown, onContextMenu }: Props) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (renaming) input.current?.select();
  }, [renaming]);

  return (
    <div
      onPointerDown={onPointerDown}
      onContextMenu={onContextMenu}
      title={ghost}
      className={clsx("absolute select-none rounded-lg", selected && "bg-white/20", ghost && "opacity-40 outline-1 outline-dashed outline-white/50")}
      style={{ left: x, top: y, width: CELL_W, height: CELL_H, fontFamily: "sans-serif" }}
    >
      <img
        src={iconUrl}
        alt=""
        draggable={false}
        className="absolute object-contain"
        style={{ left: (CELL_W - DESKTOP_ICON) / 2, top: 5, width: DESKTOP_ICON, height: DESKTOP_ICON }}
      />
      {!!added && (
        <span
          title={`${added} added`}
          className="absolute grid place-items-center rounded-full bg-[#c6ff1f] text-[#0a0614] ring-[3px] ring-[#0a0614]"
          style={{ left: (CELL_W + DESKTOP_ICON) / 2 - 16, top: 0, width: 26, height: 26 }}
        >
          <Plus className="size-5" strokeWidth={3.5} />
        </span>
      )}
      {startup && (
        <span title="Opens on startup" className="absolute right-4 top-1 grid size-[18px] place-items-center rounded-full bg-[#c6ff1f] text-[#0a0614] ring-2 ring-[#0a0614]">
          <Power className="size-2.5" strokeWidth={3} />
        </span>
      )}
      {renaming ? (
        <input
          ref={input}
          defaultValue={label}
          onPointerDown={(e) => e.stopPropagation()}
          onBlur={(e) => onRename?.(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onRename?.(e.currentTarget.value);
            if (e.key === "Escape") onRename?.(null);
          }}
          className="absolute left-0.5 w-[92px] rounded bg-black/70 px-1 text-center text-[12px] text-white outline-none ring-1 ring-[#c6ff1f]"
          style={{ top: DESKTOP_ICON + 10 }}
        />
      ) : (
        <span
          className="absolute left-0.5 line-clamp-2 w-[92px] overflow-hidden text-center text-[12px] text-white"
          style={{ top: DESKTOP_ICON + 11, lineHeight: "14px" }}
        >
          {label}
        </span>
      )}
    </div>
  );
}
