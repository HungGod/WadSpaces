// Web apps' icons: wadd makes them (wad-icons) before an image builds, from
// the site's own icon or the picture you chose, and keeps them. Asking as the
// design changes means a build finds them ready instead of fetching them.
import { useEffect, useRef, useState } from "react";
import { toBuildSpec } from "@core/build";
import type { WadspaceSpec } from "@core/model";
import { hasLocal } from "./machine";
import { wadd } from "./wadd";

export interface IconSource {
  site: string;
  custom?: string;
}

/** The icons a design's web apps need. */
export function webappSources(ws: Pick<WadspaceSpec, "layout" | "advanced">): IconSource[] {
  const spec = toBuildSpec({ id: "icons", name: "icons", description: "", ...ws } as WadspaceSpec).spec;
  return spec.webapps.map((w) => ({ site: w.url, ...(w.iconUrl && { custom: w.iconUrl }) }));
}

/** The picture you chose for an icon (an upload or an address), not a stock favicon. */
export function chosenPicture(iconUrl: string): string | undefined {
  if (iconUrl.startsWith("data:image/")) return iconUrl;
  try {
    const u = new URL(iconUrl);
    return u.protocol === "https:" && u.host !== "www.google.com" ? iconUrl : undefined;
  } catch {
    return undefined;
  }
}

const onRustWadd = async () => hasLocal && (await wadd.kind().catch(() => "py")) === "rs";

/** Asks wadd to make a design's web app icons, a moment after it changes. */
export function usePrefetchIcons(ws: Pick<WadspaceSpec, "layout" | "advanced">) {
  const sent = useRef("");
  const key = hasLocal ? JSON.stringify(webappSources(ws)) : "[]";
  useEffect(() => {
    if (key === "[]" || key === sent.current) return;
    const t = setTimeout(async () => {
      if (!(await onRustWadd())) return;
      sent.current = key;
      wadd.prefetchIcons(JSON.parse(key) as IconSource[]).catch(() => {});
    }, 1500);
    return () => clearTimeout(t);
  }, [key]);
}

export interface MadeIcon {
  png: string;
  kind: "site" | "custom" | "fallback";
}

/** The icon a web app will get in its image (null until wadd says, or off the machine). */
export function useWebappIcon(site: string | undefined, iconUrl: string): MadeIcon | null {
  const [made, setMade] = useState<MadeIcon | null>(null);
  const custom = chosenPicture(iconUrl);
  useEffect(() => {
    setMade(null);
    if (!site) return;
    let gone = false;
    const t = setTimeout(async () => {
      if (!(await onRustWadd())) return;
      try {
        const r = await wadd.webappIcon(site, custom);
        if (!gone) setMade(r);
      } catch {
        // No preview: the build still makes one.
      }
    }, 400);
    return () => {
      gone = true;
      clearTimeout(t);
    };
  }, [site, custom]);
  return made;
}
