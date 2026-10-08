import { useState } from "react";
import type { Layout } from "@/lib/types";
import { Desktop } from "./desktop/Desktop";

/** The Builder's preview: a live desktop where icons can be moved around for the session but nothing is saved. Startup apps open on mount. */
export function RunDesktop({ layout: initial, title }: { layout: Layout; title: string }) {
  const [layout, setLayout] = useState(initial);
  return <Desktop layout={layout} onChange={setLayout} title={title} autostart className="h-full w-full" />;
}
