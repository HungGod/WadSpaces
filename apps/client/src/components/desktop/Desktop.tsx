// The wadspace's desktop as the image shows it: labwc with selkies-desktop
// on top (images/base). It's laid out at the machine's screen size in
// logical pixels, with selkies-desktop's fixed sizes, then scaled to fit.
//
// What's on it comes from the wadspace's layers (core/layers.ts): the
// template's apps, the customization's web apps, the mounted projects. The
// image decides the rest: icons fill columns top to bottom in a fixed grid,
// windows are maximized with no title bar, and the panel has no clock or
// tray. Every mouse button is a click.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import clsx from "clsx";
import type { DesktopItem, MenuApp, MenuCategory } from "@core/layers";
import type { Wallpaper } from "@/lib/types";
import { DesktopIcon } from "./DesktopIcon";
import { cellAt } from "./geometry";
import { useScreen } from "./look";
import { Taskbar } from "./Taskbar";
import { activeWin, useWindows } from "./useWindows";
import { wallpaperStyle } from "./wallpapers";
import { Window } from "./Window";

/** selkies-desktop: two clicks on the same icon this close together open it. */
const DOUBLE_CLICK_MS = 300;

interface Props {
  items: DesktopItem[];
  menu: MenuCategory[];
  wallpaper: Wallpaper;
  /** Item ids to open once the desktop is up, like a real start. */
  autostart?: string[];
  className?: string;
  style?: React.CSSProperties;
}

export function Desktop({ items, menu, wallpaper, autostart, className, style }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const screen = useScreen();
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [wm, dispatch] = useWindows();
  const [selected, setSelected] = useState<string | null>(null);
  const lastClick = useRef({ id: "", t: 0 });
  const [startOpen, setStartOpen] = useState(false);

  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setBox({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const scale = box.w ? Math.min(box.w / screen.w, box.h / screen.h) : 0;
  const active = activeWin(wm);

  const open = (item: { id: string; label: string; iconUrl: string }) => dispatch({ type: "open", app: { key: item.id, title: item.label, iconUrl: item.iconUrl } });
  const launch = (app: MenuApp) => {
    setStartOpen(false);
    // A menu entry and its desktop icon share a window.
    const icon = items.find((i) => i.id === app.key);
    open(icon ?? { id: app.key, label: app.name, iconUrl: app.iconUrl });
  };

  // Apps set to open at boot open one after another once the desktop has a size.
  const boot = useRef({ items, autostart });
  const ready = scale > 0;
  useEffect(() => {
    if (!ready || !boot.current.autostart?.length) return;
    const list = boot.current.items.filter((i) => boot.current.autostart!.includes(i.id));
    const timers = list.map((item, n) => setTimeout(() => open(item), 450 + n * 320));
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  /** A click highlights an icon; a second click on it within 300ms opens it. */
  const onIconDown = (item: DesktopItem) => (e: React.PointerEvent) => {
    e.stopPropagation();
    setStartOpen(false);
    const again = lastClick.current.id === item.id && e.timeStamp - lastClick.current.t < DOUBLE_CLICK_MS;
    if (again) {
      open(item);
      setSelected(null);
      lastClick.current = { id: "", t: 0 };
    } else {
      setSelected(item.id);
      lastClick.current = { id: item.id, t: e.timeStamp };
    }
  };

  return (
    <div ref={root} className={clsx("relative isolate overflow-hidden bg-[#0b0b14]", className)} style={style} onContextMenu={(e) => e.preventDefault()}>
      {scale > 0 && (
        <div
          className="absolute left-0 top-0 origin-top-left overflow-hidden"
          style={{
            width: screen.w,
            height: screen.h,
            transform: `translate(${(box.w - screen.w * scale) / 2}px, ${(box.h - screen.h * scale) / 2}px) scale(${scale})`,
            ...wallpaperStyle(wallpaper),
          }}
          onPointerDown={() => {
            setSelected(null);
            setStartOpen(false);
          }}
        >
          {/* selkies-desktop draws icon.png at its own size in the middle of the desktop. */}

          {items.map((item, n) => {
            const p = cellAt(n, screen.h);
            return <DesktopIcon key={item.id} label={item.label} iconUrl={item.iconUrl} x={p.x} y={p.y} selected={selected === item.id} onPointerDown={onIconDown(item)} />;
          })}

          {wm.stack.map((id, z) => {
            const w = wm.wins.find((x) => x.id === id);
            return w && !w.minimized ? <Window key={w.id} win={w} z={10 + z} onQuit={() => dispatch({ type: "close", id: w.id })} /> : null;
          })}

          <Taskbar
            screenW={screen.w}
            wins={wm.wins}
            activeId={active?.id ?? null}
            menu={menu}
            menuOpen={startOpen}
            onToggleMenu={() => setStartOpen((o) => !o)}
            onWindowClick={(id) => {
              setStartOpen(false);
              dispatch({ type: "taskbar", id });
            }}
            onLaunch={launch}
          />
        </div>
      )}
    </div>
  );
}
