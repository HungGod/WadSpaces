import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import clsx from "clsx";
import type { Layout, LayoutIcon } from "@/lib/types";
import { favicon } from "@/lib/favicon";
import { DesktopIcon } from "./DesktopIcon";
import { IconEditor } from "./IconEditor";
import { Taskbar } from "./Taskbar";
import { Window } from "./Window";
import { activeWin, useWindows } from "./useWindows";
import { wallpaperStyle } from "./wallpapers";
import {
  ICON_H,
  ICON_W,
  TASKBAR_H,
  cellToPx,
  clamp,
  gridDims,
  nextFreeCell,
  resolveIcons,
  snapRect,
  snapToGrid,
  toPx,
  type Size,
  type SnapState,
} from "./geometry";

export const APP_DRAG_TYPE = "application/x-wadapp";
export interface DraggedApp {
  appId: string;
  label: string;
  domain?: string;
  iconUrl?: string;
  color: string;
}

/** Build a desktop icon from a catalog app. Position is filled in by the caller. */
export function iconFromDrag(app: DraggedApp): LayoutIcon {
  return {
    id: `i-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    appId: app.appId,
    label: app.label,
    iconUrl: app.iconUrl ?? favicon(app.domain ?? ""),
    color: app.color,
    // Custom apps are websites; the image opens this address as a web app.
    ...(app.appId.startsWith("custom-") && app.domain ? { url: /^https?:\/\//.test(app.domain) ? app.domain : `https://${app.domain}` } : {}),
    x: 0,
    y: 0,
  };
}

interface Props {
  layout: Layout;
  /** Called when icons move or are edited. Without it icons can't be moved. */
  onChange?: (layout: Layout) => void;
  /** Builder mode: drop apps in, rename, re-icon, remove. */
  editable?: boolean;
  title?: string;
  onWallpaperRequest?: () => void;
  /** Open every `autostart` icon's window once the desktop is up, like a real login. */
  autostart?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

type Menu = { x: number; y: number; iconId?: string } | null;

export function Desktop({ layout, onChange, editable, title = "Wadspace", onWallpaperRequest, autostart, className, style }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const menuEl = useRef<HTMLDivElement>(null);
  const areaEl = useRef<HTMLDivElement>(null);
  const [area, setArea] = useState<Size>({ w: 0, h: 0 });
  const [{ wins }, dispatch] = useWindows();
  const [preview, setPreview] = useState<Exclude<SnapState, "normal"> | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [menu, setMenu] = useState<Menu>(null);
  const [dragIcon, setDragIcon] = useState<{ id: string; x: number; y: number } | null>(null);
  const [dropHover, setDropHover] = useState(false);

  // Track the work area (desktop minus taskbar) so windows and icons can scale with it.
  useLayoutEffect(() => {
    const el = areaEl.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setArea({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const active = activeWin(wins);
  const topZ = wins.reduce((m, w) => Math.max(m, w.z), 10);

  const setIcons = useCallback(
    (fn: (icons: LayoutIcon[]) => LayoutIcon[]) => onChange?.({ ...layout, icons: fn(layout.icons) }),
    [layout, onChange],
  );

  const positions = area.w > 0 ? resolveIcons(layout.icons, area, layout.grid) : {};
  const iconPx = (i: LayoutIcon) => positions[i.id] ?? { x: 0, y: 0 };

  /** Where an icon dropped at px coords lands: a free grid cell, or a clamped free position. */
  const place = (x: number, y: number, ignoreId?: string): Pick<LayoutIcon, "x" | "y" | "cell"> => {
    if (layout.grid) {
      const want = snapToGrid(x, y, area);
      const cell = nextFreeCell(layout.icons, area, want, ignoreId);
      const px = resolveIcons([{ id: "_", x: 0, y: 0, cell }], area, true)._;
      return { cell, x: px.x / area.w, y: px.y / area.h };
    }
    return { x: clamp(x, 0, area.w - ICON_W) / area.w, y: clamp(y, 0, area.h - ICON_H) / area.h, cell: undefined };
  };

  const openIcon = (icon: LayoutIcon) => dispatch({ type: "open", icon });

  // Startup apps open one after another once the work area has a size, using the layout the desktop booted with.
  const bootIcons = useRef(layout.icons);
  const ready = area.w > 0;
  useEffect(() => {
    if (!autostart || !ready) return;
    const timers = bootIcons.current.filter((i) => i.autostart).map((icon, n) => setTimeout(() => dispatch({ type: "open", icon }), 450 + n * 320));
    return () => timers.forEach(clearTimeout);
  }, [autostart, ready, dispatch]);

  // ---- Icon dragging ----
  const onIconPointerDown = (icon: LayoutIcon) => (e: React.PointerEvent) => {
    if (e.button !== 0 || renaming === icon.id) return;
    e.stopPropagation();
    setSelected(icon.id);
    setMenu(null);
    root.current?.focus({ preventScroll: true });
    if (!onChange) return;
    const start = iconPx(icon);
    const sx = e.clientX;
    const sy = e.clientY;
    let moved = false;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      moved = true;
      setDragIcon({ id: icon.id, x: clamp(start.x + dx, 0, area.w - ICON_W), y: clamp(start.y + dy, 0, area.h - ICON_H) });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDragIcon(null);
      if (!moved) return;
      const p = place(start.x + ev.clientX - sx, start.y + ev.clientY - sy, icon.id);
      setIcons((icons) => icons.map((i) => (i.id === icon.id ? { ...i, ...p } : i)));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // ---- Dropping apps from the builder catalog ----
  const onDragOver = (e: React.DragEvent) => {
    if (!editable || !e.dataTransfer.types.includes(APP_DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setDropHover(true);
  };
  const onDrop = (e: React.DragEvent) => {
    setDropHover(false);
    const raw = e.dataTransfer.getData(APP_DRAG_TYPE);
    if (!editable || !raw) return;
    e.preventDefault();
    const app = JSON.parse(raw) as DraggedApp;
    const b = areaEl.current!.getBoundingClientRect();
    const icon: LayoutIcon = { ...iconFromDrag(app), ...place(e.clientX - b.left - ICON_W / 2, e.clientY - b.top - ICON_H / 2) };
    setIcons((icons) => [...icons, icon]);
    setSelected(icon.id);
  };

  // ---- Icon edits ----
  const removeIcon = (id: string) => {
    setIcons((icons) => icons.filter((i) => i.id !== id));
    dispatch({ type: "closeIcon", iconId: id });
    setSelected(null);
  };
  const updateIcon = (updated: LayoutIcon) => {
    setIcons((icons) => icons.map((i) => (i.id === updated.id ? updated : i)));
    dispatch({ type: "syncIcon", icon: updated });
  };
  const arrange = () => onChange?.(arrangeLayout(layout, area));

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (renaming || editing || (e.target as HTMLElement).tagName === "INPUT") return;
    const icon = layout.icons.find((i) => i.id === selected);
    if (!icon) return;
    if (e.key === "Enter") openIcon(icon);
    if (editable && (e.key === "Delete" || e.key === "Backspace")) removeIcon(icon.id);
    if (editable && e.key === "F2") setRenaming(icon.id);
  };

  // Close the context menu on outside click / Escape.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const outside = (e: PointerEvent) => !menuEl.current?.contains(e.target as Node) && close();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", esc);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("keydown", esc);
      window.removeEventListener("blur", close);
    };
  }, [menu]);

  const openMenu = (e: React.MouseEvent, iconId?: string) => {
    e.preventDefault();
    e.stopPropagation();
    const b = root.current!.getBoundingClientRect();
    setMenu({ x: Math.min(e.clientX - b.left, b.width - 200), y: Math.min(e.clientY - b.top, b.height - 230), iconId });
    if (iconId) setSelected(iconId);
  };

  const menuIcon = layout.icons.find((i) => i.id === menu?.iconId);
  const editingIcon = layout.icons.find((i) => i.id === editing);
  const previewPx = preview && area.w ? toPx(snapRect(preview), area) : null;

  return (
    <div
      ref={root}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className={clsx("relative isolate overflow-hidden outline-none", className)}
      style={{ ...wallpaperStyle(layout.wallpaper), ...style }}
      onContextMenu={(e) => openMenu(e)}
    >
      {/* Work area */}
      <div
        ref={areaEl}
        className="absolute inset-x-0 top-0"
        style={{ bottom: TASKBAR_H }}
        onPointerDown={() => {
          setSelected(null);
          setMenu(null);
        }}
        onDragOver={onDragOver}
        onDragLeave={() => setDropHover(false)}
        onDrop={onDrop}
      >
        {dropHover && <div className="pointer-events-none absolute inset-2 rounded-xl border-2 border-dashed border-[#c6ff1f]/70 bg-[#c6ff1f]/5" />}

        {area.w > 0 &&
          layout.icons.map((icon) => {
            const d = dragIcon?.id === icon.id ? dragIcon : null;
            const p = d ?? iconPx(icon);
            return (
              <DesktopIcon
                key={icon.id}
                icon={icon}
                x={p.x}
                y={p.y}
                dragging={!!d}
                selected={selected === icon.id}
                renaming={renaming === icon.id}
                startup={editable && !!icon.autostart}
                onPointerDown={onIconPointerDown(icon)}
                onDoubleClick={() => openIcon(icon)}
                onContextMenu={(e) => openMenu(e, icon.id)}
                onRename={(label) => {
                  setRenaming(null);
                  if (label?.trim()) updateIcon({ ...icon, label: label.trim() });
                }}
              />
            );
          })}

        {editable && layout.icons.length === 0 && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center">
            <div className="rounded-2xl border border-dashed border-white/25 bg-black/20 px-6 py-5 text-center text-white/80 backdrop-blur-sm">
              <div className="font-display text-lg font-semibold">Drag apps here</div>
              <div className="mt-1 text-sm text-white/60">Double-click an icon to open its window</div>
            </div>
          </div>
        )}

        {previewPx && (
          <div
            className="pointer-events-none absolute rounded-xl border border-white/40 bg-white/10 backdrop-blur-[2px] transition-all duration-150"
            style={{ left: previewPx.x + 6, top: previewPx.y + 6, width: previewPx.w - 12, height: previewPx.h - 12, zIndex: topZ }}
          />
        )}

        {area.w > 0 && (
          <AnimatePresence>
            {wins.map((w) => (
              <Window
                key={w.id}
                win={w}
                area={area}
                areaEl={areaEl}
                active={active?.id === w.id}
                dispatch={dispatch}
                onSnapPreview={setPreview}
              />
            ))}
          </AnimatePresence>
        )}
      </div>

      <Taskbar
        wins={wins}
        activeId={active?.id ?? null}
        icons={layout.icons}
        title={title}
        onWindowClick={(id) => dispatch({ type: "taskbar", id })}
        onLaunch={openIcon}
      />

      {/* Context menu */}
      <AnimatePresence>
        {menu && (
          <motion.div
            initial={{ opacity: 0, scale: 0.97 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.08 } }}
            ref={menuEl}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => setMenu(null)}
            className="absolute z-[9500] min-w-[190px] origin-top-left rounded-xl border border-white/10 bg-[#140d22]/95 p-1 text-[13px] text-white shadow-2xl backdrop-blur-xl"
            style={{ left: menu.x, top: menu.y }}
          >
            {menuIcon ? (
              <>
                <MenuItem onClick={() => openIcon(menuIcon)}>Open</MenuItem>
                {editable && (
                  <>
                    <MenuItem onClick={() => setRenaming(menuIcon.id)} hint="F2">Rename</MenuItem>
                    <MenuItem onClick={() => setEditing(menuIcon.id)}>Change icon & color…</MenuItem>
                    <MenuItem onClick={() => updateIcon({ ...menuIcon, autostart: !menuIcon.autostart })} hint={menuIcon.autostart ? "On" : "Off"}>
                      Open on startup
                    </MenuItem>
                    <div className="my-1 h-px bg-white/10" />
                    <MenuItem danger onClick={() => removeIcon(menuIcon.id)} hint="Del">Remove from desktop</MenuItem>
                  </>
                )}
              </>
            ) : (
              <>
                {editable && onWallpaperRequest && <MenuItem onClick={onWallpaperRequest}>Change wallpaper…</MenuItem>}
                {editable && (
                  <MenuItem onClick={() => onChange?.({ ...layout, grid: !layout.grid })}>
                    {layout.grid ? "Turn off grid snapping" : "Turn on grid snapping"}
                  </MenuItem>
                )}
                {onChange && <MenuItem onClick={arrange}>Arrange icons</MenuItem>}
                <MenuItem onClick={() => wins.forEach((w) => dispatch({ type: "minimize", id: w.id }))}>Show desktop</MenuItem>
                <MenuItem onClick={() => wins.forEach((w) => dispatch({ type: "close", id: w.id }))}>Close all windows</MenuItem>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {editingIcon && (
        <IconEditor
          icon={editingIcon}
          onCancel={() => setEditing(null)}
          onSave={(icon) => {
            updateIcon(icon);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function MenuItem({ children, onClick, danger, hint }: { children: React.ReactNode; onClick: () => void; danger?: boolean; hint?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        "flex w-full items-center justify-between gap-6 rounded-lg px-2.5 py-1.5 text-left transition-colors",
        danger ? "text-[#ff6b9b] hover:bg-[#ff5d7a]/15" : "hover:bg-white/10",
      )}
    >
      {children}
      {hint && <span className="text-[11px] text-white/35">{hint}</span>}
    </button>
  );
}

/** Line icons up in grid order (column-major) and turn grid snapping on. */
export function arrangeLayout(layout: Layout, area: Size): Layout {
  const { rows } = gridDims(area);
  const icons = layout.icons.map((i, n) => {
    const cell = { col: Math.floor(n / rows), row: n % rows };
    const px = cellToPx(cell.col, cell.row);
    return { ...i, cell, x: px.x / area.w, y: px.y / area.h };
  });
  return { ...layout, grid: true, icons };
}
