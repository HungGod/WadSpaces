// Download each catalog app's icon into public/catalog/<id>.png and point
// apps.json at it, so the app shows icons offline (on a kiosk with no Wi-Fi).
// Re-run after adding apps: node scripts/fetch-catalog-icons.mjs
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const catalogPath = resolve(root, "src/core/catalog/apps.json");
const outDir = resolve(root, "public/catalog");
mkdirSync(outDir, { recursive: true });

const apps = JSON.parse(readFileSync(catalogPath, "utf8"));
let fetched = 0;
for (const app of apps) {
  // Apps with a hand-picked icon (public/icons/*) keep it.
  if (app.iconUrl && !app.iconUrl.startsWith("/catalog/")) continue;
  const file = resolve(outDir, `${app.id}.png`);
  if (!existsSync(file)) {
    const url = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(app.domain)}&sz=128`;
    const r = await fetch(url);
    if (!r.ok) {
      console.warn(`skip ${app.id}: HTTP ${r.status}`);
      continue;
    }
    writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    fetched++;
  }
  app.iconUrl = `/catalog/${app.id}.png`;
}
writeFileSync(catalogPath, JSON.stringify(apps, null, 2) + "\n");
console.log(`fetched ${fetched}, catalog has ${apps.length} apps`);
