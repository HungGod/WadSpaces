// The web app's pages as pictures, dark and light: what the native client
// (apps/desktop) is checked against. Against the fake backend:
//
//   npm run dev:fake -- --port 5198 &
//   node scripts/reference-shots.mjs http://localhost:5198 ../../fixtures/client-shots
//
// Needs playwright-core and Chromium, as scripts/overflow-probe.mjs does.
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? `${repo}.build/uitools/node_modules/playwright-core`);
const base = process.argv[2] ?? "http://localhost:5198";
const out = process.argv[3] ?? `${repo}fixtures/client-shots`;
const exe = process.env.CHROMIUM ?? `${homedir()}/.cache/ms-playwright/chromium-1148/chrome-linux/chrome`;

// [name, path, then: what to do once it's shown]
const SHOTS = [
  ["home", "/"],
  ["builder", "/builder"],
  ["secrets", "/secrets"],
  ["machines", "/machines"],
  ["machines-storage", "/machines", (p) => p.getByRole("button", { name: "Storage", exact: true }).click()],
  ["machines-files", "/machines", (p) => p.getByRole("button", { name: "Files", exact: true }).click()],
  ["machines-diagnostics", "/machines", (p) => p.getByRole("button", { name: "Diagnostics", exact: true }).click()],
  ["launcher", "/", (p) => p.getByRole("button", { name: "Launch", exact: true }).first().click()],
  ["sidebar-collapsed", "/", (p) => p.getByRole("button", { name: "Collapse sidebar" }).click()],
];

mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: exe });
for (const theme of ["dark", "light"]) {
  for (const [name, path, then] of SHOTS) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    await ctx.addInitScript((t) => {
      localStorage.setItem("ws-theme", t);
      localStorage.setItem("ws-sidebar", "open");
    }, theme);
    const page = await ctx.newPage();
    await page.goto(base + path, { waitUntil: "networkidle" });
    await page.waitForTimeout(600);
    if (then) {
      await then(page);
      await page.waitForTimeout(700);
    }
    await page.screenshot({ path: `${out}/${name}-${theme}.png` });
    console.log(`${name}-${theme}`);
    await ctx.close();
  }
}
await browser.close();
