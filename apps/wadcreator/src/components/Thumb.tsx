import clsx from "clsx";
import type { Wadspace } from "@/lib/types";
import { DesktopThumb } from "./desktop/DesktopThumb";

export function Thumb({ ws, className }: { ws: Wadspace; className?: string }) {
  return <DesktopThumb layout={ws.layout} className={clsx("aspect-video w-full", className)} />;
}
