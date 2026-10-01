export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Size {
  w: number;
  h: number;
}
export type SnapState = "normal" | "max" | "left" | "right";
export type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export const MIN_W = 260;
export const MIN_H = 170;
/** Distance from an edge (px) at which a dragged window offers to snap. */
export const SNAP_EDGE = 10;
export const TASKBAR_H = 46;

export const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), Math.max(min, max));

export const toPx = (r: Rect, a: Size): Rect => ({ x: r.x * a.w, y: r.y * a.h, w: r.w * a.w, h: r.h * a.h });
export const toFrac = (r: Rect, a: Size): Rect => ({ x: r.x / a.w, y: r.y / a.h, w: r.w / a.w, h: r.h / a.h });

/** Rect for a snapped state, in fractions of the work area. */
export function snapRect(state: Exclude<SnapState, "normal">): Rect {
  if (state === "left") return { x: 0, y: 0, w: 0.5, h: 1 };
  if (state === "right") return { x: 0.5, y: 0, w: 0.5, h: 1 };
  return { x: 0, y: 0, w: 1, h: 1 };
}

/** Keep a px rect fully inside the work area, shrinking it if the area is too small. */
export function clampRect(r: Rect, a: Size): Rect {
  const minW = Math.min(MIN_W, a.w);
  const minH = Math.min(MIN_H, a.h);
  const w = clamp(r.w, minW, a.w);
  const h = clamp(r.h, minH, a.h);
  return { w, h, x: clamp(r.x, 0, a.w - w), y: clamp(r.y, 0, a.h - h) };
}

/** Resize from a handle. Edges stop at the work-area boundary and at the minimum size. */
export function resizeRect(start: Rect, handle: Handle, dx: number, dy: number, a: Size): Rect {
  const minW = Math.min(MIN_W, a.w);
  const minH = Math.min(MIN_H, a.h);
  let { x, y, w, h } = start;
  if (handle.includes("e")) w = clamp(start.w + dx, minW, a.w - start.x);
  if (handle.includes("s")) h = clamp(start.h + dy, minH, a.h - start.y);
  if (handle.includes("w")) {
    const right = start.x + start.w;
    x = clamp(start.x + dx, 0, right - minW);
    w = right - x;
  }
  if (handle.includes("n")) {
    const bottom = start.y + start.h;
    y = clamp(start.y + dy, 0, bottom - minH);
    h = bottom - y;
  }
  return { x, y, w, h };
}

/** Which snap zone (if any) the pointer is in, in work-area px coordinates. */
export function snapZone(px: number, py: number, a: Size): Exclude<SnapState, "normal"> | null {
  if (py <= SNAP_EDGE) return "max";
  if (px <= SNAP_EDGE) return "left";
  if (px >= a.w - SNAP_EDGE) return "right";
  return null;
}

// ---- Desktop icon grid ----
export const CELL_W = 92;
export const CELL_H = 104;
export const GRID_PAD = 10;
export const ICON_W = 84;
export const ICON_H = 92;

export function gridDims(a: Size) {
  return {
    cols: Math.max(1, Math.floor((a.w - GRID_PAD * 2 + (CELL_W - ICON_W)) / CELL_W)),
    rows: Math.max(1, Math.floor((a.h - GRID_PAD * 2 + (CELL_H - ICON_H)) / CELL_H)),
  };
}

export function snapToGrid(px: number, py: number, a: Size) {
  const { cols, rows } = gridDims(a);
  const col = clamp(Math.round((px - GRID_PAD) / CELL_W), 0, cols - 1);
  const row = clamp(Math.round((py - GRID_PAD) / CELL_H), 0, rows - 1);
  return { col, row, cols, rows };
}

export const cellToPx = (col: number, row: number) => ({ x: GRID_PAD + col * CELL_W, y: GRID_PAD + row * CELL_H });

type Cell = { col: number; row: number };
type IconLike = { id: string; x: number; y: number; cell?: Cell };

/** Desired grid cell for an icon: its stored cell, or its free position snapped. */
const wantedCell = (i: IconLike, a: Size): Cell => i.cell ?? snapToGrid(i.x * a.w, i.y * a.h, a);

/**
 * Resolve every icon to a px position for a given work area.
 * In grid mode, cells are placed in order (column-major like a real desktop): rows that don't fit
 * wrap into the next column and collisions move to the next free cell, so icons never overlap.
 */
export function resolveIcons(icons: IconLike[], a: Size, grid: boolean) {
  const out: Record<string, { x: number; y: number; cell?: Cell }> = {};
  if (!grid) {
    for (const i of icons) out[i.id] = { x: clamp(i.x * a.w, 0, a.w - ICON_W), y: clamp(i.y * a.h, 0, a.h - ICON_H) };
    return out;
  }
  const { cols, rows } = gridDims(a);
  const total = cols * rows;
  const taken = new Set<number>();
  for (const i of icons) {
    const want = wantedCell(i, a);
    let idx = clamp(Math.min(want.col, cols - 1) * rows + want.row, 0, total - 1);
    for (let n = 0; n < total && taken.has(idx); n++) idx = (idx + 1) % total;
    taken.add(idx);
    const cell = { col: Math.floor(idx / rows), row: idx % rows };
    out[i.id] = { ...cellToPx(cell.col, cell.row), cell };
  }
  return out;
}

/** First free grid cell (column-major) given the icons already on the desktop. */
export function nextFreeCell(icons: IconLike[], a: Size, from: Cell = { col: 0, row: 0 }, ignoreId?: string): Cell {
  const { cols, rows } = gridDims(a);
  const total = cols * rows;
  const resolved = resolveIcons(icons.filter((i) => i.id !== ignoreId), a, true);
  const taken = new Set(Object.values(resolved).map((p) => p.cell!.col * rows + p.cell!.row));
  let idx = clamp(Math.min(from.col, cols - 1) * rows + Math.min(from.row, rows - 1), 0, total - 1);
  for (let n = 0; n < total && taken.has(idx); n++) idx = (idx + 1) % total;
  return { col: Math.floor(idx / rows), row: idx % rows };
}

/** Readable text color (near-black or white) for a background hex color. */
export function inkFor(hex: string) {
  const m = hex.replace("#", "").match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i);
  if (!m) return "#ffffff";
  const [r, g, b] = m.slice(1).map((v) => parseInt(v, 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.45 ? "#0a0614" : "#ffffff";
}
