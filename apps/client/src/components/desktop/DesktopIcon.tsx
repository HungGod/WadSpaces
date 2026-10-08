import { useEffect, useRef } from "react";
import { Power } from "lucide-react";
import clsx from "clsx";
import type { LayoutIcon } from "@/lib/types";
import { ICON_H, ICON_W } from "./geometry";
import { localIcon } from "@core/catalog/icons";

interface Props {
  icon: LayoutIcon;
  x: number;
  y: number;
  selected?: boolean;
  dragging?: boolean;
  renaming?: boolean;
  /** Show the "opens on startup" marker (builder only). */
  startup?: boolean;
  onRename?: (label: string | null) => void;
  onPointerDown?: (e: React.PointerEvent) => void;
  onDoubleClick?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}

export function DesktopIcon({ icon, x, y, selected, dragging, renaming, startup, onRename, onPointerDown, onDoubleClick, onContextMenu }: Props) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (renaming) input.current?.select();
  }, [renaming]);

  return (
    <div
      data-icon={icon.id}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      className={clsx(
        "group absolute flex select-none flex-col items-center gap-1.5 rounded-lg p-1.5 pt-2 touch-none",
        dragging ? "z-[5] opacity-80" : "transition-[left,top] duration-150",
        selected ? "bg-white/15 ring-1 ring-white/30" : "hover:bg-white/10",
      )}
      style={{ left: x, top: y, width: ICON_W, height: ICON_H }}
    >
      <div className="relative grid size-12 place-items-center rounded-xl bg-white/10 shadow-[0_6px_16px_-6px_rgba(0,0,0,0.6)] ring-1 ring-white/10 backdrop-blur-sm">
        <img src={localIcon(icon.iconUrl)} alt="" className="size-8 rounded-md" draggable={false} />
        {startup && (
          <span title="Opens on startup" className="absolute -right-1.5 -top-1.5 grid size-5 place-items-center rounded-full bg-[#c6ff1f] text-[#0a0614] ring-2 ring-[#0a0614]">
            <Power className="size-3" strokeWidth={3} />
          </span>
        )}
      </div>
      {renaming ? (
        <input
          ref={input}
          defaultValue={icon.label}
          onPointerDown={(e) => e.stopPropagation()}
          onBlur={(e) => onRename?.(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onRename?.(e.currentTarget.value);
            if (e.key === "Escape") onRename?.(null);
          }}
          className="w-[88px] rounded bg-black/70 px-1 text-center text-[11.5px] text-white outline-none ring-1 ring-[#c6ff1f]"
        />
      ) : (
        <span className="line-clamp-2 w-full text-center text-[11.5px] leading-tight text-white [text-shadow:0_1px_3px_rgba(0,0,0,0.9)]">
          {icon.label}
        </span>
      )}
    </div>
  );
}
