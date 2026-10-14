// A desktop for cards: the image's desktop scaled down, nothing open, the
// WadSpaces logo in the middle and on the Start button.
import { useLayoutEffect, useRef, useState } from "react";
import type { DesktopItem } from "@core/layers";
import type { Wallpaper } from "@/lib/types";
import { DesktopIcon } from "./DesktopIcon";
import { PANEL_H, START_W, cellAt } from "./geometry";
import { useScreen } from "./look";
import { wallpaperStyle } from "./wallpapers";

/** Non-interactive, scaled-down render of a desktop for cards: the image's desktop, nothing open. VS Code with extensions gets a +. */
/** `zoom`: draw it as on a screen this many times smaller, so icons read at card size (they wrap into columns sooner). */
export function DesktopThumb({ items, wallpaper, className, zoom = 1 }: { items: DesktopItem[]; wallpaper: Wallpaper; className?: string; zoom?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const real = useScreen();
  const screen = { w: Math.round(real.w / zoom), h: Math.round(real.h / zoom) };

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Cover the card, as a wallpaper would: the top-left (where icons start) stays in view.
  const scale = size.w ? Math.max(size.w / screen.w, size.h / screen.h) : 0;
  return (
    <div ref={box} className={className} style={{ position: "relative", overflow: "hidden", background: "#0b0b14" }}>
      {scale > 0 && (
        <div className="pointer-events-none absolute left-0 top-0 origin-top-left" style={{ width: screen.w, height: screen.h, transform: `scale(${scale})`, ...wallpaperStyle(wallpaper) }}>
          {items.map((item, n) => {
            const p = cellAt(n, screen.h);
            return <DesktopIcon key={item.id} label={item.label} iconUrl={item.iconUrl} x={p.x} y={p.y} added={item.added} />;
          })}
          <div className="absolute inset-x-0 bottom-0 bg-[rgb(26,26,26)]" style={{ height: PANEL_H }}>
            <div className="absolute left-1 top-1 rounded bg-[rgb(64,64,64)]" style={{ width: START_W - 8, height: PANEL_H - 8 }} />
          </div>
        </div>
      )}
    </div>
  );
}
