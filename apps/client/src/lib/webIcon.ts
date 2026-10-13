// A web app's icon, for an <img>. In the app, wadd fetches the site's own icon
// once and keeps it (wadd-icon:, src-tauri/src/webicon.rs); the window's CSP
// lets no site's pictures in directly. In a browser (the web portal), Google's
// favicon service. Sites the catalog brings icons for use those.
import { webappIcon as favicon } from "@core/layers";
import { inTauri } from "./shell";

const BUNDLED: Record<string, string> = { "claude.ai": "/icons/claude.png", "chatgpt.com": "/icons/codex.png" };

export function siteIcon(url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return "/favicon.svg";
  }
  return BUNDLED[host] ?? (inTauri ? `wadd-icon://localhost/web?site=${encodeURIComponent(url)}` : favicon(url));
}

/** For an <img onError>: a site with no icon shows WadSpaces' mark instead of a broken picture. */
export const noIcon = (e: { currentTarget: HTMLImageElement }) => {
  if (!e.currentTarget.src.endsWith("/favicon.svg")) e.currentTarget.src = "/favicon.svg";
};

/** An icon URL as the core makes it (Google's favicon service for a web app's
 *  host), turned into the app's own (`siteIcon`); any other URL as it is. */
export function iconSrc(src: string): string {
  if (!inTauri || !src.startsWith("https://www.google.com/s2/favicons")) return src;
  const domain = new URL(src).searchParams.get("domain");
  return domain ? siteIcon(`https://${domain}`) : src;
}
