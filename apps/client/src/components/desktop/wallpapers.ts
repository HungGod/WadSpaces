import type { Wallpaper } from "@/lib/types";

export const WALLPAPER_PRESETS: { name: string; wallpaper: Wallpaper }[] = [
  { name: "Nebula", wallpaper: { type: "gradient", value: "radial-gradient(90% 70% at 80% 10%, #ff3d8155 0%, transparent 60%), radial-gradient(70% 60% at 10% 90%, #5b2bff44 0%, transparent 60%), #0a0614" } },
  { name: "Acid", wallpaper: { type: "gradient", value: "radial-gradient(80% 80% at 100% 100%, #d4ff3d55 0%, transparent 55%), linear-gradient(160deg, #0a0614 30%, #13210a 100%)" } },
  { name: "Wad", wallpaper: { type: "gradient", value: "radial-gradient(60% 60% at 30% 30%, #ff3d8166 0%, transparent 60%), radial-gradient(60% 60% at 75% 75%, #d4ff3d44 0%, transparent 60%), #0a0614" } },
  { name: "Midnight", wallpaper: { type: "gradient", value: "linear-gradient(180deg, #0b1020 0%, #0a0614 100%)" } },
  { name: "Aurora", wallpaper: { type: "gradient", value: "radial-gradient(120% 60% at 50% 0%, #1de9b644 0%, transparent 60%), radial-gradient(80% 60% at 20% 30%, #7c4dff44 0%, transparent 60%), #06121a" } },
  { name: "Sunset", wallpaper: { type: "gradient", value: "linear-gradient(170deg, #2a0b2e 0%, #7a1f3d 55%, #ff8a3d 120%)" } },
  { name: "Ocean", wallpaper: { type: "gradient", value: "linear-gradient(160deg, #031526 0%, #0c3b5e 60%, #1b7fa6 120%)" } },
  { name: "Graphite", wallpaper: { type: "gradient", value: "linear-gradient(160deg, #2a2a2e 0%, #121214 100%)" } },
  { name: "Paper", wallpaper: { type: "gradient", value: "linear-gradient(160deg, #f1f1f1 0%, #d4d4d4 100%)" } },
];

export function wallpaperStyle(w: Wallpaper): React.CSSProperties {
  if (w.type === "image") return { backgroundImage: `url("${w.value}")`, backgroundSize: "cover", backgroundPosition: "center", backgroundColor: "#0a0614" };
  return { background: w.value };
}
