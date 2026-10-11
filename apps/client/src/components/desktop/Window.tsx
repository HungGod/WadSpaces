// A maximized window with no title bar (labwc-rc.xml): the app's picture
// and name standing in for the app itself in the preview.
import { localIcon } from "@core/catalog/icons";
import { PANEL_H } from "./geometry";
import type { Win } from "./useWindows";

/**
 * A running app's window: labwc maximizes it over the desktop, down to the
 * panel, with no title bar to move, resize or close it by. The app itself
 * closes it, so the stand-in content has a Quit button.
 */
export function Window({ win, z, onQuit }: { win: Win; z: number; onQuit: () => void }) {
  return (
    <div
      className="absolute inset-x-0 top-0 flex flex-col items-center justify-center gap-3 bg-[#202020] text-[#e6e6e6]"
      style={{ bottom: PANEL_H, zIndex: z, fontFamily: "sans-serif" }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <img src={localIcon(win.iconUrl)} alt="" className="size-16 object-contain" draggable={false} />
      <div className="text-[18px]">{win.title}</div>
      <div className="max-w-[420px] text-center text-[13px] text-[#9a9a9a]">Running here, maximized: labwc gives every window the whole desktop above the panel and no title bar.</div>
      <button type="button" onClick={onQuit} className="mt-2 rounded border border-[#666] bg-[#333] px-4 py-1.5 text-[13px] hover:bg-[#444]">
        Quit {win.title}
      </button>
    </div>
  );
}
