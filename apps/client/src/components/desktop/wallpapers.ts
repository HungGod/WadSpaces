// The backgrounds a wadspace can pick: shaded gradients in the WadSpaces
// colours (deep violet, acid green, hot pink, ice blue), drawn here; or a
// picture of your own. The blank one a new customization starts with, and
// how a desktop draws one. (Pictures named by path, /wallpapers/..., still
// draw: older wadspaces have them.)
import type { Wallpaper } from "@/lib/types";

export const WALLPAPER_PRESETS: { name: string; wallpaper: Wallpaper }[] = [
  { name: "Aurora", wallpaper: { type: "gradient", value: "radial-gradient(120% 90% at 12% 8%, rgb(198 255 31 / 0.38), transparent 55%), radial-gradient(110% 85% at 88% 92%, rgb(255 61 129 / 0.5), transparent 60%), linear-gradient(160deg, #0a0614, #1b132d)" } },
  { name: "Nebula", wallpaper: { type: "gradient", value: "radial-gradient(75% 70% at 72% 30%, rgb(255 61 129 / 0.55), transparent 62%), radial-gradient(90% 90% at 18% 82%, rgb(127 211 255 / 0.38), transparent 62%), linear-gradient(200deg, #140d22, #07040e)" } },
  { name: "Acid Dusk", wallpaper: { type: "gradient", value: "radial-gradient(120% 75% at 50% 108%, rgb(198 255 31 / 0.5), transparent 62%), radial-gradient(90% 60% at 50% 100%, rgb(59 29 94 / 0.8), transparent 75%), linear-gradient(175deg, #0a0614 0%, #1b132d 60%, #2a1747 100%)" } },
  { name: "Neon Tide", wallpaper: { type: "gradient", value: "radial-gradient(80% 65% at 50% 112%, rgb(127 211 255 / 0.6), transparent 70%), radial-gradient(60% 50% at 85% 10%, rgb(255 61 129 / 0.25), transparent 70%), linear-gradient(180deg, #0a0614, #142640)" } },
  { name: "Ember", wallpaper: { type: "gradient", value: "radial-gradient(80% 80% at 92% 8%, rgb(255 61 129 / 0.7), transparent 60%), radial-gradient(60% 60% at 8% 100%, rgb(255 179 107 / 0.32), transparent 65%), linear-gradient(135deg, #1d0a1c, #0a0614)" } },
  { name: "Glacier", wallpaper: { type: "gradient", value: "radial-gradient(90% 75% at 28% 18%, rgb(127 211 255 / 0.48), transparent 60%), radial-gradient(70% 70% at 90% 95%, rgb(198 255 31 / 0.14), transparent 65%), linear-gradient(160deg, #0d1a2c, #07040e)" } },
  { name: "Midnight", wallpaper: { type: "gradient", value: "radial-gradient(120% 80% at 50% -5%, rgb(120 64 210 / 0.6), transparent 65%), radial-gradient(50% 40% at 50% 100%, rgb(255 61 129 / 0.18), transparent 70%), linear-gradient(180deg, #140d22, #05030a)" } },
  { name: "Prism", wallpaper: { type: "gradient", value: "radial-gradient(60% 70% at 18% 28%, rgb(255 61 129 / 0.5), transparent 65%), radial-gradient(60% 70% at 82% 22%, rgb(127 211 255 / 0.45), transparent 65%), radial-gradient(75% 70% at 55% 100%, rgb(198 255 31 / 0.34), transparent 65%), #0e0919" } },
  { name: "Haze", wallpaper: { type: "gradient", value: "radial-gradient(100% 100% at 0% 0%, rgb(198 255 31 / 0.26), transparent 55%), radial-gradient(100% 100% at 100% 100%, rgb(127 211 255 / 0.3), transparent 55%), radial-gradient(70% 70% at 60% 40%, rgb(255 61 129 / 0.26), transparent 60%), #0e0919" } },
];

/** What templates and Extensions are pictured on. */
export const DEFAULT_WALLPAPER: Wallpaper = WALLPAPER_PRESETS[0].wallpaper;

/** A new customization's background until one's picked: not one of the
 *  choices, so it reads as "not set". */
export const BLANK_WALLPAPER: Wallpaper = { type: "gradient", value: "linear-gradient(160deg, #17112a 0%, #0e0919 100%)" };
export const isBlankWallpaper = (w: Wallpaper | undefined) => !w || w.value === BLANK_WALLPAPER.value;

export function wallpaperStyle(w: Wallpaper): React.CSSProperties {
  if (w.type === "image") return { backgroundImage: `url("${w.value}")`, backgroundSize: "cover", backgroundPosition: "center", backgroundColor: "#0a0614" };
  return { background: w.value };
}
