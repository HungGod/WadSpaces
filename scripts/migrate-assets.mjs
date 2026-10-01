// One-shot, before the Storage bucket goes (infra/teardown.sh): wallpapers and
// custom icons uploaded online were Firebase Storage URLs; the app now keeps
// them in the doc as data URLs. This rewrites the old ones the same way, in
// wadspaces/* and users/*/drafts/* (layout.wallpaper.value of an "image"
// wallpaper, and layout.icons[].iconUrl).
//
// Images are copied as they are, without resizing: one over 300 KB would
// push the doc toward Firestore's 1 MiB limit, so it's listed for a manual
// re-upload instead (the app downscales new uploads).
//
//   npm --prefix functions ci                  # firebase-admin comes from functions/
//   gcloud auth application-default login      # or GOOGLE_APPLICATION_CREDENTIALS=<key.json>
//   node scripts/migrate-assets.mjs            # dry run: says what it would change
//   node scripts/migrate-assets.mjs --apply    # rewrites the docs
//
// --project <id> picks the project (default: GOOGLE_CLOUD_PROJECT, else wad-spaces).
import { createRequire } from "node:module";

const require = createRequire(new URL("../functions/package.json", import.meta.url));
const { applicationDefault, initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const at = args.indexOf("--project");
const projectId = (at >= 0 && args[at + 1]) || process.env.GOOGLE_CLOUD_PROJECT || "wad-spaces";
const MAX_BYTES = 300 * 1024;
const STORAGE_URL = /^https:\/\/(firebasestorage|storage)\.googleapis\.com\//;

const credential = applicationDefault();
initializeApp({ credential, projectId });
const db = getFirestore();

/** What the bytes are, when the server doesn't say. */
function sniff(b) {
  const hex = b.subarray(0, 4).toString("hex");
  if (hex === "89504e47") return "image/png";
  if (hex.startsWith("ffd8ff")) return "image/jpeg";
  if (hex === "47494638") return "image/gif";
  if (b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP") return "image/webp";
  if (/^\s*(<\?xml|<svg)/.test(b.subarray(0, 100).toString())) return "image/svg+xml";
  return null;
}

const cache = new Map();
/** The image as a data URL, or why not. */
function toDataUrl(url) {
  if (!cache.has(url)) {
    cache.set(
      url,
      (async () => {
        let r = await fetch(url);
        // storage.googleapis.com objects need the caller's credentials; Firebase download URLs carry a token.
        if ((r.status === 401 || r.status === 403) && url.startsWith("https://storage.googleapis.com/")) {
          const { access_token } = await credential.getAccessToken();
          r = await fetch(url, { headers: { Authorization: `Bearer ${access_token}` } });
        }
        if (!r.ok) return { error: `download failed: HTTP ${r.status}` };
        const bytes = Buffer.from(await r.arrayBuffer());
        if (bytes.length > MAX_BYTES) return { error: `${Math.round(bytes.length / 1024)} KB, too big to inline: re-upload it in the app` };
        const header = (r.headers.get("content-type") ?? "").split(";")[0].trim();
        const type = header.startsWith("image/") ? header : sniff(bytes);
        if (!type) return { error: `not an image (${header || "no content type"})` };
        return { dataUrl: `data:${type};base64,${bytes.toString("base64")}` };
      })().catch((e) => ({ error: `download failed: ${e.message}` })),
    );
  }
  return cache.get(url);
}

const stats = { docs: 0, found: 0, rewritten: 0, manual: [] };

/** Rewrite one doc's layout; returns the fields to update, or null. */
async function migrate(path, layout) {
  if (!layout || typeof layout !== "object") return null;
  const update = {};
  const hit = async (where, url) => {
    stats.found++;
    const res = await toDataUrl(url);
    if (res.error) {
      stats.manual.push(`${path} ${where}: ${res.error}\n    ${url}`);
      return null;
    }
    stats.rewritten++;
    return res.dataUrl;
  };

  const wp = layout.wallpaper;
  if (wp?.type === "image" && STORAGE_URL.test(wp.value ?? "")) {
    const dataUrl = await hit("wallpaper", wp.value);
    if (dataUrl) update["layout.wallpaper"] = { ...wp, value: dataUrl };
  }
  if (Array.isArray(layout.icons)) {
    let changed = false;
    const icons = [];
    for (const icon of layout.icons) {
      if (STORAGE_URL.test(icon?.iconUrl ?? "")) {
        const dataUrl = await hit(`icon "${icon.label ?? icon.id}"`, icon.iconUrl);
        if (dataUrl) {
          icons.push({ ...icon, iconUrl: dataUrl });
          changed = true;
          continue;
        }
      }
      icons.push(icon);
    }
    if (changed) update["layout.icons"] = icons;
  }
  return Object.keys(update).length ? update : null;
}

async function run(snap) {
  for (const d of snap.docs) {
    stats.docs++;
    const update = await migrate(d.ref.path, d.get("layout"));
    if (!update) continue;
    console.log(`${apply ? "rewriting" : "would rewrite"} ${d.ref.path}: ${Object.keys(update).join(", ")}`);
    if (apply) {
      try {
        await d.ref.update(update);
      } catch (e) {
        stats.manual.push(`${d.ref.path}: update failed: ${e.message}`);
      }
    }
  }
}

console.log(`${apply ? "Migrating" : "Dry run on"} project ${projectId}`);
await run(await db.collection("wadspaces").get());
const drafts = await db.collectionGroup("drafts").get();
await run({ docs: drafts.docs.filter((d) => d.ref.parent.parent?.parent.id === "users") });

console.log(`\n${stats.docs} docs, ${stats.found} Storage images, ${stats.rewritten} ${apply ? "rewritten" : "can be rewritten"}`);
if (stats.manual.length) {
  console.log(`\nNeeds a manual look (${stats.manual.length}):`);
  for (const m of stats.manual) console.log(`  ${m}`);
  process.exitCode = 1;
}
if (!apply) console.log("\nNothing was changed. Run with --apply to rewrite.");
