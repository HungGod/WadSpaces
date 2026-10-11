import clsx from "clsx";
import { AppWindow } from "lucide-react";
import type { Wadspace } from "@/lib/types";
import { DesktopThumb } from "./desktop/DesktopThumb";
import { APP_PRODUCTS, ProductMark } from "./Logo";

export function Thumb({ ws, className }: { ws: Wadspace; className?: string }) {
  // The machine's own apps have no desktop to draw: their mark instead.
  if (ws.app) {
    const product = APP_PRODUCTS[ws.id];
    return (
      <div className={clsx("grid aspect-video w-full place-items-center bg-surface-3 text-muted ring-1 ring-line", className)}>
        {product ? <ProductMark product={product} className="aspect-square h-3/5 w-auto" /> : <AppWindow className="size-1/3" strokeWidth={1.5} />}
      </div>
    );
  }
  return <DesktopThumb layout={ws.layout} className={clsx("aspect-video w-full", className)} />;
}
