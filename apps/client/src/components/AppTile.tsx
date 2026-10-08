import clsx from "clsx";
import { appIcon } from "@/lib/templates";
import type { App } from "@/lib/types";

/** An app's icon on a rounded tile, like a launcher. */
export function AppTile({ app, size = 44, glass, className, style }: { app: App; size?: number; glass?: boolean; className?: string; style?: React.CSSProperties }) {
  return (
    <span
      title={app.name}
      className={clsx("grid shrink-0 place-items-center rounded-[28%] ring-1", glass ? "bg-white/90 shadow-lg ring-white/40 backdrop-blur" : "bg-surface-2 ring-line", className)}
      style={{ width: size, height: size, ...style }}
    >
      <img src={appIcon(app)} alt={app.name} className="rounded-md" style={{ width: size * 0.6, height: size * 0.6 }} draggable={false} />
    </span>
  );
}
