// Catalog icons ship with the app (public/catalog, scripts/fetch-catalog-icons.mjs).
// Layouts saved before that point at Google's favicon service; show the
// bundled copy instead so icons work with no internet.
import apps from "./apps.json";

const byDomain = new Map<string, string>(
  (apps as { domain: string; iconUrl?: string }[]).filter((a) => a.iconUrl).map((a) => [a.domain, a.iconUrl!]),
);

export function localIcon(url: string): string {
  if (!url.startsWith("https://www.google.com/s2/favicons")) return url;
  try {
    const domain = new URL(url).searchParams.get("domain");
    return (domain && byDomain.get(domain)) || url;
  } catch {
    return url;
  }
}
