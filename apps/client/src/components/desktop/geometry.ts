// The desktop as the image draws it: selkies-desktop's fixed sizes as
// WadSpaces builds it (apps/selkies-desktop, desktop.h and ui.c), in logical
// pixels. The image has no settings for any of these, so neither does the Builder.

export interface Size {
  w: number;
  h: number;
}

/** The bottom panel. It reserves its height, so maximized windows stop above it. */
export const PANEL_H = 44;
/** The Start button's slot at the left of the panel (the button itself is 8px narrower). */
export const START_W = 52;
/** The WadSpaces logo on the Start button. */
export const START_ICON = 34;
/** Windows' icons in the panel. */
export const TASK_ICON = 22;
/** Icons in the Start menu. */
export const SMALL_ICON = 16;
/** A desktop icon's picture. */
export const DESKTOP_ICON = 48;
/** One desktop icon's cell. */
export const CELL_W = 96;
export const CELL_H = 104;
/** Gap from the screen's top-left corner to the first cell. */
export const GRID_PAD = 10;
/** Taskbar buttons: at most this wide, with this gap between them. */
export const TASK_MAX_W = 150;
export const TASK_GAP = 5;
/** The Start menu: category and app lists, rows, and how tall they can get. */
export const MENU_CAT_W = 180;
export const MENU_APP_W = 250;
export const MENU_ROW_H = 30;
export const MENU_MAX_H = 600;

/** How many icons fit in a column above the panel. */
export const rowsFor = (screenH: number) => Math.max(1, Math.floor((screenH - PANEL_H) / CELL_H));

/** Where the n-th desktop icon goes (get_desktop_cell): down each column, then the next column. */
export function cellAt(index: number, screenH: number) {
  const rows = rowsFor(screenH);
  return { x: Math.floor(index / rows) * CELL_W + GRID_PAD, y: (index % rows) * CELL_H + GRID_PAD };
}

/** Width of each taskbar button for this many open windows. */
export function taskButtonWidth(screenW: number, windows: number) {
  if (!windows) return TASK_MAX_W;
  const room = screenW - START_W - TASK_GAP - windows * TASK_GAP;
  return Math.max(TASK_ICON + 10, Math.min(TASK_MAX_W, Math.floor(room / windows)));
}

/** Where the app list sits for the hovered category (update_menu_heights): beside it, kept on screen. */
export function appListOffset(categories: number, hovered: number, apps: number) {
  const catH = Math.min(categories * MENU_ROW_H + 10, MENU_MAX_H);
  const appH = Math.min(apps * MENU_ROW_H + 10, MENU_MAX_H);
  const centre = catH - 5 - hovered * MENU_ROW_H - 15;
  const fromBottom = Math.min(MENU_MAX_H, Math.max(appH, Math.round(centre + appH / 2)));
  return { catH, appH, fromBottom };
}
