// Finds what can pan sideways: every element that scrolls (or would, on a
// touch screen) further than it shows, on each page of the offline UI, at
// the Surface's screen sizes. A kiosk's pages should only ever scroll the
// way they're meant to.
//
//   npm run build && npx vite preview --port 5199 &   (or a dev server)
//   node scripts/overflow-probe.mjs http://localhost:5199
//
// Needs playwright-core (not one of the app's dependencies): set
// PLAYWRIGHT_CORE to its folder (default: <repo>/.build/uitools/node_modules/
// playwright-core) and CHROMIUM to a Chromium binary (default: Playwright's).
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? `${repo}.build/uitools/node_modules/playwright-core`);
const base = process.argv[2] ?? "http://localhost:5199";
const exe = process.env.CHROMIUM ?? `${homedir()}/.cache/ms-playwright/chromium-1148/chrome-linux/chrome`;

const PAGES = process.env.PROBE_PAGES?.split(",") ?? ["/", "/wadspaces", "/projects", "/launch", "/manager", "/builder"];
// Surface Pro (2736x1824 at 2x), the spike's screen, and a wider one.
const SIZES = [
  [1368, 912],
  [1280, 800],
  [1824, 1216],
];

// Run in the page: what overflows sideways, and where.
function probe() {
  const out = [];
  const name = (el) => {
    const id = el.id ? `#${el.id}` : "";
    const tour = el.dataset?.tour ? `[data-tour=${el.dataset.tour}]` : "";
    const cls = typeof el.className === "string" ? `.${el.className.trim().split(/\s+/).slice(0, 4).join(".")}` : "";
    return `${el.tagName.toLowerCase()}${id}${tour}${cls}`;
  };
  const doc = document.scrollingElement;
  if (doc.scrollWidth > doc.clientWidth + 1) out.push(`page: ${doc.scrollWidth} > ${doc.clientWidth}`);
  for (const el of document.querySelectorAll("body *")) {
    const cs = getComputedStyle(el);
    // Shelves meant to scroll sideways snap along x: those are fine.
    const pans = (cs.overflowX === "auto" || cs.overflowX === "scroll") && !cs.scrollSnapType.startsWith("x");
    if (pans && el.scrollWidth > el.clientWidth + 1) {
      // The widest thing inside, as a lead.
      let widest = null;
      const box = el.getBoundingClientRect();
      for (const c of el.querySelectorAll("*")) {
        const r = c.getBoundingClientRect();
        if (r.right > box.right + 1 && (!widest || r.right > widest.r)) widest = { r: r.right, n: name(c) };
      }
      out.push(`${name(el)}: ${el.scrollWidth} > ${el.clientWidth}${widest ? ` (past the edge: ${widest.n})` : ""}`);
    }
  }
  // Cut off at the screen's edge (outside a shelf): the layout is too wide.
  const shelf = (el) => {
    for (let a = el.parentElement; a; a = a.parentElement) if (getComputedStyle(a).scrollSnapType.startsWith("x")) return true;
    return false;
  };
  // Inside something that clips it before the edge: not seen, not scrollable.
  const clipped = (el) => {
    for (let a = el.parentElement; a; a = a.parentElement) {
      const o = getComputedStyle(a).overflowX;
      if ((o === "hidden" || o === "clip") && a.getBoundingClientRect().right <= innerWidth + 1) return true;
    }
    return false;
  };
  for (const el of document.querySelectorAll("main *, aside *, header *")) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.right > innerWidth + 1 && getComputedStyle(el).position !== "fixed" && !shelf(el) && !clipped(el)) {
      out.push(`cut off: ${name(el)} ends at ${Math.round(r.right)} > ${innerWidth}`);
      break;
    }
  }
  return out;
}

const browser = await chromium.launch({ executablePath: exe });
let problems = 0;
for (const [w, h] of SIZES) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, hasTouch: true });
  for (const p of PAGES) {
    await page.goto(base + p, { waitUntil: "networkidle" }).catch(() => {});
    await page.waitForTimeout(600);
    const found = new Set(await page.evaluate(probe));
    // Hovering (or a touch that leaves :hover behind) scales tiles and cards.
    for (const sel of ["[draggable=true]", "[data-tour=library] button", "a[href]"]) {
      for (const el of (await page.$$(sel)).slice(0, 40)) {
        await el.hover({ timeout: 300 }).catch(() => {});
        for (const f of await page.evaluate(probe)) found.add(`${f} [hovering ${sel}]`);
      }
    }
    // The Builder's steps and its right panel's tabs.
    if (p === "/builder") {
      for (const sel of ["header ol button, ol button", "aside button.flex-1"]) {
        for (const el of await page.$$(sel)) {
          await el.click({ timeout: 500 }).catch(() => {});
          await page.waitForTimeout(250);
          const label = (await el.textContent().catch(() => "")).trim().slice(0, 20);
          for (const f of await page.evaluate(probe)) found.add(`${f} [after ${label}]`);
        }
      }
    }
    for (const f of found) {
      problems++;
      console.log(`${w}x${h} ${p}  ${f}`);
    }
  }
  await page.close();
}
await browser.close();
console.log(problems ? `${problems} found` : "nothing pans sideways");
