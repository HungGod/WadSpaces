import { useLayoutEffect, useRef, useState } from "react";
import type { Layout } from "@/lib/types";
import { DesktopIcon } from "./DesktopIcon";
import { TASKBAR_H, resolveIcons } from "./geometry";
import { wallpaperStyle } from "./wallpapers";

const VW = 1200;
const VH = 675;

/** Non-interactive, scaled-down render of a layout for cards and pickers. */
export function DesktopThumb({ layout, className }: { layout: Layout; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setScale(e.contentRect.width / VW));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pos = resolveIcons(layout.icons, { w: VW, h: VH - TASKBAR_H }, layout.grid);
  return (
    <div ref={box} className={className} style={{ position: "relative", overflow: "hidden", ...wallpaperStyle(layout.wallpaper) }}>
      {scale > 0 && (
        <div className="pointer-events-none absolute left-0 top-0 origin-top-left" style={{ width: VW, height: VH, transform: `scale(${scale})` }}>
          {layout.icons.map((i) => (
            <DesktopIcon key={i.id} icon={i} x={pos[i.id].x} y={pos[i.id].y} />
          ))}
          <div className="absolute inset-x-0 bottom-0 flex items-center gap-2 border-t border-white/10 bg-[#0a0614]/70 px-3" style={{ height: TASKBAR_H }}>
            <img src="/brand/wadspaces-icon-dark-transparent.svg" alt="" className="size-7" />
          </div>
        </div>
      )}
    </div>
  );
}
