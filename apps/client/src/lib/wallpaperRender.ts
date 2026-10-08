// Builder wallpapers are CSS (gradients, a colour, or an image); the real
// desktop (swaybg in the image) needs a file. This draws one to a canvas the
// way the browser draws the CSS: layers bottom-up, linear and elliptical
// radial gradients, and images cropped to cover.
import type { Wallpaper } from "./types";

export const WALLPAPER_SIZE = { w: 1920, h: 1080 };

/** Split on commas that aren't inside parentheses. */
export function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

interface Stop {
  color: string;
  at?: number;
}

/** "#ff3d8155 0%" → {color, at: 0}; stops without a position are spread evenly, like CSS. */
export function parseStops(parts: string[]): { color: string; at: number }[] {
  const stops: Stop[] = parts.map((p) => {
    const m = p.match(/^(.*?)\s+(-?[\d.]+)%$/);
    return m ? { color: m[1].trim(), at: Number(m[2]) / 100 } : { color: p.trim() };
  });
  if (stops[0] && stops[0].at === undefined) stops[0].at = 0;
  const last = stops[stops.length - 1];
  if (last && last.at === undefined) last.at = 1;
  for (let i = 1; i < stops.length - 1; i++) {
    if (stops[i].at !== undefined) continue;
    let j = i;
    while (stops[j].at === undefined) j++;
    const a = stops[i - 1].at!;
    const b = stops[j].at!;
    for (let k = i; k < j; k++) stops[k].at = a + ((b - a) * (k - i + 1)) / (j - i + 1);
  }
  return stops.map((s) => ({ color: s.color, at: s.at! }));
}

function addStops(g: CanvasGradient, stops: { color: string; at: number }[]) {
  // Canvas wants 0..1; CSS allows stops past the ends (e.g. 120%). Clamp.
  for (const s of stops) g.addColorStop(Math.min(1, Math.max(0, s.at)), s.color);
}

function drawLayer(ctx: CanvasRenderingContext2D, layer: string, w: number, h: number) {
  const fn = layer.match(/^(linear|radial)-gradient\((.*)\)$/s);
  if (!fn) {
    ctx.fillStyle = layer;
    ctx.fillRect(0, 0, w, h);
    return;
  }
  const args = splitTop(fn[2]);
  if (fn[1] === "linear") {
    let deg = 180;
    if (/deg$/.test(args[0])) deg = Number.parseFloat(args.shift()!);
    else if (/^to /.test(args[0])) {
      const dir = args.shift()!;
      deg = { "to top": 0, "to right": 90, "to bottom": 180, "to left": 270 }[dir] ?? 180;
    }
    const a = (deg * Math.PI) / 180;
    const len = Math.abs(w * Math.sin(a)) + Math.abs(h * Math.cos(a));
    const dx = (Math.sin(a) * len) / 2;
    const dy = (-Math.cos(a) * len) / 2;
    const g = ctx.createLinearGradient(w / 2 - dx, h / 2 - dy, w / 2 + dx, h / 2 + dy);
    addStops(g, parseStops(args));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    return;
  }
  // radial-gradient(RX% RY% at X% Y%, stops…) — the only shape the presets use.
  let rx = 0.5 * w;
  let ry = 0.5 * h;
  let cx = w / 2;
  let cy = h / 2;
  const shape = args[0].match(/^([\d.]+)%\s+([\d.]+)%\s+at\s+([\d.]+)%\s+([\d.]+)%$/);
  if (shape) {
    args.shift();
    rx = (Number(shape[1]) / 100) * w;
    ry = (Number(shape[2]) / 100) * h;
    cx = (Number(shape[3]) / 100) * w;
    cy = (Number(shape[4]) / 100) * h;
  }
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  addStops(g, parseStops(args));
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(rx, ry);
  ctx.fillStyle = g;
  ctx.fillRect(-cx / rx, -cy / ry, w / rx, h / ry);
  ctx.restore();
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Couldn't load the wallpaper image."));
    img.src = src;
  });
}

/** The wallpaper as a file for the image: PNG for gradients and colours, JPEG for photos. */
export async function renderWallpaper(w: Wallpaper): Promise<{ blob: Blob; fileName: string }> {
  const canvas = document.createElement("canvas");
  let { w: cw, h: ch } = WALLPAPER_SIZE;
  let img: HTMLImageElement | null = null;
  if (w.type === "image") {
    img = await loadImage(w.value);
    // Keep the photo's own resolution, up to 2560 wide.
    const scale = Math.min(1, 2560 / img.naturalWidth);
    cw = Math.round(img.naturalWidth * scale);
    ch = Math.round(img.naturalHeight * scale);
  }
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#0a0614";
  ctx.fillRect(0, 0, cw, ch);
  if (img) ctx.drawImage(img, 0, 0, cw, ch);
  else if (w.type === "color") drawLayer(ctx, w.value, cw, ch);
  else for (const layer of splitTop(w.value).reverse()) drawLayer(ctx, layer, cw, ch);
  const type = w.type === "image" ? "image/jpeg" : "image/png";
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't render the wallpaper."))), type, 0.9));
  return { blob, fileName: type === "image/png" ? "wallpaper.png" : "wallpaper.jpg" };
}
