// selkies-desktop's panel, drawn to its sizes and colours (ui.c draw_frame):
// a Start button, then one button per open window. No clock, tray or search:
// the machine's HUD shows those, outside the wadspace.
import { useState } from "react";
import clsx from "clsx";
import type { MenuApp, MenuCategory } from "@core/layers";
import { MENU_APP_W, MENU_CAT_W, MENU_ROW_H, PANEL_H, SMALL_ICON, START_W, TASK_GAP, appListOffset, taskButtonWidth } from "./geometry";
import { LOGO } from "./look";
import type { Win } from "./useWindows";

const FONT = { fontFamily: "sans-serif" };

interface Props {
  screenW: number;
  wins: Win[];
  activeId: string | null;
  menu: MenuCategory[];
  menuOpen: boolean;
  onToggleMenu: () => void;
  onWindowClick: (id: string) => void;
  onLaunch: (app: MenuApp) => void;
}

export function Taskbar({ screenW, wins, activeId, menu, menuOpen, onToggleMenu, onWindowClick, onLaunch }: Props) {
  const btnW = taskButtonWidth(screenW, wins.length);
  return (
    <>
      <div className="absolute inset-x-0 bottom-0 z-[9000] bg-[rgb(26,26,26)]" style={{ height: PANEL_H, ...FONT }} onPointerDown={(e) => e.stopPropagation()}>
        <button
          type="button"
          aria-label="Start"
          onClick={onToggleMenu}
          className="absolute left-1 top-1 grid place-items-center rounded bg-[rgb(64,64,64)]"
          style={{ width: START_W - 8, height: PANEL_H - 8 }}
        >
          <img src={LOGO} alt="" style={{ width: SMALL_ICON, height: SMALL_ICON }} draggable={false} />
        </button>
        {wins.map((w, i) => (
          <button
            key={w.id}
            type="button"
            onClick={() => onWindowClick(w.id)}
            title={w.title}
            className={clsx(
              "absolute top-[3px] flex items-center gap-[5px] overflow-hidden whitespace-nowrap rounded border border-[rgb(102,102,102)] pl-[5px] text-left text-[12px] text-[rgb(230,230,230)]",
              w.id === activeId ? "bg-[rgb(77,77,77)]" : w.minimized ? "bg-[rgb(13,13,13)]" : "bg-[rgb(38,38,38)]",
            )}
            style={{ left: START_W + TASK_GAP + i * (btnW + TASK_GAP), width: btnW, height: PANEL_H - 6 }}
          >
            <img src={w.iconUrl} alt="" className="shrink-0 object-contain" style={{ width: SMALL_ICON, height: SMALL_ICON }} draggable={false} />
            <span className="overflow-hidden pr-[5px]">{w.title}</span>
          </button>
        ))}
      </div>
      {menuOpen && <StartMenu menu={menu} onLaunch={onLaunch} />}
    </>
  );
}

/** Categories on the left; hovering one shows its apps beside it. Clicking an app opens it and closes the menu. */
function StartMenu({ menu, onLaunch }: { menu: MenuCategory[]; onLaunch: (app: MenuApp) => void }) {
  const [hovered, setHovered] = useState(-1);
  const cat = menu[hovered];
  const { catH, appH, fromBottom } = appListOffset(menu.length, Math.max(0, hovered), cat?.apps.length ?? 0);
  const row = "flex w-full items-center text-left text-[13px] text-white hover:bg-[rgb(77,77,77)]";

  return (
    <div className="absolute inset-0 z-[9100]" style={FONT} onPointerDown={(e) => e.stopPropagation()}>
      <div className="absolute left-[2px] overflow-y-auto rounded-lg bg-[rgb(38,38,38)] py-[5px]" style={{ bottom: PANEL_H + 4, width: MENU_CAT_W, height: catH }}>
        {menu.map((c, i) => (
          <div key={c.name} onPointerEnter={() => setHovered(i)} className={clsx(row, "relative pl-[10px]", i === hovered && "bg-[rgb(77,77,77)]")} style={{ height: MENU_ROW_H }}>
            {c.name}
            <svg className="absolute" style={{ left: 158, top: 9 }} width="9" height="12" viewBox="0 0 9 12" fill="none" stroke="white" strokeWidth="1.5">
              <path d="M2 1l5 5-5 5" />
            </svg>
          </div>
        ))}
      </div>
      {cat && (
        <div
          className="absolute overflow-y-auto rounded-lg bg-[rgb(46,46,46)] py-[5px]"
          style={{ left: 2 + MENU_CAT_W + 4, bottom: PANEL_H + 4 + fromBottom - appH, width: MENU_APP_W, height: appH }}
        >
          {cat.apps.map((a) => (
            <button key={a.key} type="button" onClick={() => onLaunch(a)} className={clsx(row, "gap-[10px] pl-[10px]")} style={{ height: MENU_ROW_H }}>
              <img src={a.iconUrl} alt="" className="shrink-0 object-contain" style={{ width: SMALL_ICON, height: SMALL_ICON }} draggable={false} />
              <span className="truncate">{a.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
