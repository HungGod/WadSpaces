const fs = require("fs");
const path = require("path");

function loadConfig(configPath) {
  const out = { app_name: "WadBrowser", app_url: "about:blank", icon_path: null };
  if (!configPath) return out;
  try {
    const abs = path.resolve(configPath);
    const data = JSON.parse(fs.readFileSync(abs, "utf-8"));
    if (data.app_name) out.app_name = String(data.app_name);
    if (data.app_url) out.app_url = String(data.app_url);
    if (data.icon_path) out.icon_path = path.resolve(path.dirname(abs), String(data.icon_path));
    if (data.wm_class) out.wm_class = String(data.wm_class);
    /** Basename of the .desktop file (e.g. WADspaces-claude.desktop); drives CHROME_DESKTOP / Wayland app_id like Qt setDesktopFileName. */
    if (data.desktop_file) out.desktop_file = String(data.desktop_file);
  } catch (_e) {
    // Fall back to defaults
  }
  return out;
}

function slugify(name) {
  return String(name || "wadbrowser")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "wadbrowser";
}

const PRODUCT_NAME = "WadBrowser";

/** Native window / document title: "WadBrowser - Claude" for mini-apps; plain "WadBrowser" when name is default. */
function formatWindowTitle(appName) {
  const name = (appName && String(appName).trim()) || PRODUCT_NAME;
  if (name === PRODUCT_NAME) return PRODUCT_NAME;
  return `${PRODUCT_NAME} - ${name}`;
}

module.exports = { loadConfig, slugify, formatWindowTitle, PRODUCT_NAME };

