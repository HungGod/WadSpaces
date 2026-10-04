// @ts-check
// The browser chrome: tabs, toolbar, URL bar, find row and questions. Rust
// owns the tabs (each is a WebKit view under this one); this page draws their
// state and sends the user's actions back (`act` takes the same actions as
// the keyboard shortcuts and the menus: {do: "back"}, {do: "tab-close", tab}).

/**
 * @typedef {{ id: number, title: string, url: string, favicon: string | null, loading: boolean,
 *             progress: number, canBack: boolean, canForward: boolean, audio: boolean,
 *             muted: boolean, sleeping: boolean }} TabState
 * @typedef {{ mode: "full" | "focus" | "app", name: string | null, appIcon: string | null,
 *             homeHost: string | null, canNewTab: boolean, tabs: TabState[], active: number | null,
 *             zoom: number, fullscreen: boolean }} State
 * @typedef {{ id: number, name: string, received: number, total: number,
 *             state: "running" | "done" | "failed" | "cancelled" }} Download
 * @typedef {{ do: string, [k: string]: unknown }} Action
 * @typedef {{ label?: string, key?: string, action?: Action, sep?: boolean, zoom?: number }} Item
 */

// Errors are kept for the spike to read (window.__wbErrors).
/** @type {string[]} */
const errors = (/** @type {any} */ (window).__wbErrors = []);
window.addEventListener("error", (e) => errors.push(String(e.message)));
window.addEventListener("unhandledrejection", (e) => errors.push(String(e.reason)));

/** @type {any} */
const T = /** @type {any} */ (window).__TAURI__;
/** @type {(cmd: string, args?: object) => Promise<any>} */
const invoke = T.core.invoke;
const me = T.webviewWindow.getCurrentWebviewWindow();

/** @param {string} id */
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
const tabsEl = $("tabs");
const url = /** @type {HTMLInputElement} */ ($("url"));
const findtext = /** @type {HTMLInputElement} */ ($("findtext"));

/** @type {State | null} */
let state = null;
/** @type {Download[]} */
let downloads = [];
let editing = false;
/** @type {number | null} */
let prompt = null;

/** @param {Action} action */
const act = (action) => invoke("act", { action });

// ---- state ----

/** @param {State} s */
function render(s) {
  state = s;
  const body = document.body;
  body.classList.remove("mode-full", "mode-focus", "mode-app");
  body.classList.add(`mode-${s.mode}`);
  body.classList.toggle("single", s.tabs.length < 2);
  body.classList.toggle("no-newtab", !s.canNewTab);
  placeToolbar(s.mode);

  const active = s.tabs.find((t) => t.id === s.active);
  body.classList.toggle("loading", !!active?.loading);
  $("progress").style.width = active?.loading ? `${Math.max(5, active.progress * 100)}%` : "0";
  /** @type {HTMLButtonElement} */ ($("back")).disabled = !active?.canBack;
  /** @type {HTMLButtonElement} */ ($("forward")).disabled = !active?.canForward;
  $("appname").textContent = s.name ?? active?.title ?? "";
  const icon = /** @type {HTMLImageElement} */ ($("appicon"));
  icon.hidden = !s.appIcon;
  if (s.appIcon && icon.src !== s.appIcon) icon.src = s.appIcon;
  const off = s.mode === "app" && !!s.homeHost && !!active && !sameSite(active.url, s.homeHost);
  body.classList.toggle("offsite", off);
  $("offsite").textContent = off && active ? host(active.url) : "";
  $("zoom").hidden = s.zoom === 100;
  $("zoom").textContent = `${s.zoom}%`;
  if (!editing) url.value = display(active?.url ?? "");

  const have = new Map([...tabsEl.children].map((el) => [Number(/** @type {HTMLElement} */ (el).dataset.id), el]));
  const want = s.tabs.map((t) => {
    const el = /** @type {HTMLElement} */ (have.get(t.id) ?? tabEl(t.id));
    have.delete(t.id);
    fillTab(el, t, t.id === s.active);
    return el;
  });
  for (const el of have.values()) el.remove();
  want.forEach((el, i) => {
    if (tabsEl.children[i] !== el) tabsEl.insertBefore(el, tabsEl.children[i] ?? null);
  });
}

/** Full windows have a toolbar row; the others put its buttons in the strip. */
let placed = "";
/** @param {string} mode */
function placeToolbar(mode) {
  if (placed === mode) return;
  placed = mode;
  if (mode === "full") {
    $("nav-slot").append($("nav"));
    $("tools-slot").append($("tools"));
  } else {
    $("identity").after($("nav"));
    $("offsite").after($("tools"));
  }
}

/** @param {string} u */
function display(u) {
  return u === "about:blank" ? "" : u;
}

/** @param {string} u */
function host(u) {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
}

/** Same site: the same registrable-ish domain (www., accounts. are the app's own).
 * @param {string} u @param {string} home */
function sameSite(u, home) {
  let h;
  try {
    h = new URL(u).hostname;
  } catch {
    return true;
  }
  if (!h) return true;
  const base = (/** @type {string} */ x) => x.split(".").slice(-2).join(".");
  return base(h) === base(home);
}

// ---- tabs ----

const SPEAKER = '<svg viewBox="0 0 16 16"><path d="M3 6.5h2.5L9 3.5v9l-3.5-3H3zM11.5 5.5a3.5 3.5 0 0 1 0 5"/></svg>';
const MUTED = '<svg viewBox="0 0 16 16"><path d="M3 6.5h2.5L9 3.5v9l-3.5-3H3zM11 6l3.5 4M14.5 6 11 10"/></svg>';
// Inline, not an image: an SVG image in the chrome leaves a new window
// showing its first frame for seconds (WebKitGTK).
const GLOBE =
  '<svg class="globe" viewBox="0 0 16 16"><circle class="ring" cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12"/></svg>';

/** @param {number} id */
function tabEl(id) {
  const el = document.createElement("div");
  el.className = "tab";
  el.dataset.id = String(id);
  el.setAttribute("role", "tab");
  el.draggable = true;
  el.innerHTML =
    `<span class="spinner" hidden></span><span class="fav">${GLOBE}</span>` +
    '<span class="title"></span><button class="audio" hidden></button>' +
    '<button class="x" title="Close tab (Ctrl+W)" aria-label="Close tab">' +
    '<svg viewBox="0 0 16 16"><path d="m4 4 8 8M12 4l-8 8"/></svg></button>';
  el.addEventListener("mousedown", (e) => {
    if (e.button === 1) e.preventDefault();
  });
  el.addEventListener("mouseup", (e) => {
    if (e.button === 1) act({ do: "tab-close", tab: id });
  });
  el.addEventListener("click", (e) => {
    const t = /** @type {Element} */ (e.target);
    if (t.closest(".x")) act({ do: "tab-close", tab: id });
    else if (t.closest(".audio")) act({ do: "tab-mute", tab: id });
    else act({ do: "tab-select", tab: id });
  });
  el.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    tabMenu(id, e.clientX, e.clientY);
  });
  el.addEventListener("dragstart", (e) => {
    el.classList.add("dragging");
    e.dataTransfer?.setData("application/x-wadbrowser-tab", String(id));
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    invoke("tab_drag_begin", { id });
  });
  el.addEventListener("dragend", (e) => {
    el.classList.remove("dragging");
    clearDropMarks();
    // Dropped where no tab strip took it: the tab gets a window of its own.
    invoke("tab_drag_end", { detach: e.dataTransfer?.dropEffect === "none" });
  });
  return el;
}

/** @param {HTMLElement} el @param {TabState} t @param {boolean} active */
function fillTab(el, t, active) {
  el.classList.toggle("active", active);
  el.classList.toggle("sleeping", t.sleeping);
  el.setAttribute("aria-selected", String(active));
  const title = t.title || display(t.url) || "New tab";
  /** @type {HTMLElement} */ (el.querySelector(".title")).textContent = title;
  el.title = t.sleeping ? `${title}\n(asleep: it reloads when you open it)` : title;
  /** @type {HTMLElement} */ (el.querySelector(".spinner")).hidden = !t.loading;
  const fav = /** @type {HTMLElement} */ (el.querySelector(".fav"));
  fav.hidden = t.loading;
  const src = t.favicon ?? "";
  if (fav.dataset.src !== src) {
    fav.dataset.src = src;
    fav.style.backgroundImage = src ? `url("${src}")` : "";
    fav.classList.toggle("has", !!src);
  }
  const audio = /** @type {HTMLElement} */ (el.querySelector(".audio"));
  audio.hidden = !t.audio && !t.muted;
  if (audio.dataset.icon !== String(t.muted)) {
    audio.innerHTML = t.muted ? MUTED : SPEAKER;
    audio.dataset.icon = String(t.muted);
  }
  audio.title = t.muted ? "Unmute tab" : "Mute tab";
}

/** @param {number} id @param {number} x @param {number} y */
function tabMenu(id, x, y) {
  const t = state?.tabs.find((t) => t.id === id);
  /** @type {Item[]} */
  const items = [
    { label: "Reload", action: { do: "tab-reload", tab: id } },
    { label: "Duplicate", action: { do: "tab-duplicate", tab: id } },
    { label: t?.muted ? "Unmute" : "Mute", action: { do: "tab-mute", tab: id } },
    { label: "Move to new window", action: { do: "tab-new-window", tab: id } },
    { sep: true },
    { label: "Close", key: "Ctrl+W", action: { do: "tab-close", tab: id } },
    { label: "Close other tabs", action: { do: "tab-close-others", tab: id } },
  ];
  showMenu(items, x, y + 4, 230);
}

// ---- dropping tabs (from this window or another) ----

/** @param {DragEvent} e */
function dropIndex(e) {
  const tabs = [...tabsEl.children];
  const i = tabs.findIndex((el) => {
    const r = el.getBoundingClientRect();
    return e.clientX < r.left + r.width / 2;
  });
  return i < 0 ? tabs.length : i;
}

function clearDropMarks() {
  for (const el of tabsEl.children) el.classList.remove("drop-before", "drop-after");
}

/** @param {DragEvent} e */
function isTabDrag(e) {
  return !!e.dataTransfer?.types.includes("application/x-wadbrowser-tab");
}

$("strip").addEventListener("dragover", (e) => {
  if (!isTabDrag(e)) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  clearDropMarks();
  const i = dropIndex(e);
  const tabs = tabsEl.children;
  if (i < tabs.length) tabs[i].classList.add("drop-before");
  else tabs[tabs.length - 1]?.classList.add("drop-after");
});
$("strip").addEventListener("dragleave", (e) => {
  if (!$("strip").contains(/** @type {Node | null} */ (e.relatedTarget))) clearDropMarks();
});
$("strip").addEventListener("drop", (e) => {
  if (!isTabDrag(e)) return;
  e.preventDefault();
  clearDropMarks();
  invoke("tab_drop", { index: dropIndex(e) });
});

// ---- toolbar ----

$("back").addEventListener("click", () => act({ do: "back" }));
$("forward").addEventListener("click", () => act({ do: "forward" }));
$("reload").addEventListener("click", (e) =>
  act({ do: document.body.classList.contains("loading") ? "stop" : e.shiftKey ? "reload-hard" : "reload" }),
);
$("home").addEventListener("click", () => act({ do: "home" }));
$("newtab").addEventListener("click", () => act({ do: "new-tab" }));
$("min").addEventListener("click", () => invoke("win_action", { action: "minimize" }));
$("max").addEventListener("click", () => invoke("win_action", { action: "maximize" }));
$("close").addEventListener("click", () => invoke("win_action", { action: "close" }));
$("strip").addEventListener("dblclick", (e) => {
  if (/** @type {Element} */ (e.target).hasAttribute("data-tauri-drag-region")) invoke("win_action", { action: "maximize" });
});
$("zoom").addEventListener("click", () => act({ do: "zoom-reset" }));

url.addEventListener("focus", () => {
  editing = true;
  url.select();
});
url.addEventListener("blur", () => {
  editing = false;
  if (state) render(state);
});
url.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    editing = false;
    if (state) render(state);
    invoke("focus_page");
  }
});
$("urlform").addEventListener("submit", (e) => {
  e.preventDefault();
  editing = false;
  invoke("navigate", { input: url.value });
});

// ---- menus (drawn in their own surface: ui/popup.html) ----

/** Rows' heights in the popup (popup.html's CSS), and its padding and shadow. */
const ITEM_H = 32;
const SEP_H = 9;
const PAD = 14 + 8;

/** @param {Item[]} items @param {number} x @param {number} y @param {number} width */
function showMenu(items, x, y, width) {
  const height = items.reduce((h, i) => h + (i.sep ? SEP_H : ITEM_H), PAD);
  const left = Math.max(0, Math.min(x, window.innerWidth - width));
  invoke("popup_show", { x: Math.round(left), y: Math.round(y), width, height, kind: "menu", data: { items } });
}

$("menu").addEventListener("click", () => {
  const r = $("menu").getBoundingClientRect();
  /** @type {Item[]} */
  const items = [];
  if (state?.canNewTab) items.push({ label: "New tab", key: "Ctrl+T", action: { do: "new-tab" } });
  items.push(
    { label: "New window", key: "Ctrl+N", action: { do: "new-window" } },
    { sep: true },
    { zoom: state?.zoom ?? 100 },
    { label: "Find…", key: "Ctrl+F", action: { do: "find" } },
    { label: "Print…", key: "Ctrl+P", action: { do: "print" } },
    { label: state?.fullscreen ? "Exit full screen" : "Full screen", key: "F11", action: { do: "fullscreen" } },
    { sep: true },
    { label: "Downloads", action: { do: "downloads" } },
  );
  showMenu(items, r.right - 250 + 6, r.bottom + 4, 250);
});

function showDownloads() {
  const r = $("downloads").hidden ? $("menu").getBoundingClientRect() : $("downloads").getBoundingClientRect();
  const width = 340;
  const rows = Math.min(Math.max(downloads.length, 1), 6);
  invoke("popup_show", {
    x: Math.round(Math.max(0, r.right - width + 6)),
    y: Math.round(r.bottom + 4),
    width,
    height: 44 + rows * 56 + PAD,
    kind: "downloads",
    data: { items: downloads },
  });
}
$("downloads").addEventListener("click", showDownloads);

/** @param {Download[]} list */
function renderDownloads(list) {
  downloads = list;
  $("downloads").hidden = list.length === 0;
  const running = list.filter((d) => d.state === "running");
  const got = running.reduce((n, d) => n + d.received, 0);
  const total = running.reduce((n, d) => n + d.total, 0);
  const pct = running.length && total ? Math.min(100, (got / total) * 100) : 0;
  const ring = $("dlring");
  ring.style.background = running.length ? `conic-gradient(var(--accent) ${pct}%, transparent 0)` : "none";
  ring.style.setProperty("mask", "radial-gradient(circle, transparent 9px, #000 9.5px)");
}

// ---- find in page ----

function openFind() {
  $("findbar").hidden = false;
  fit();
  findtext.focus();
  findtext.select();
}

function closeFind() {
  $("findbar").hidden = true;
  $("findcount").textContent = "";
  findtext.classList.remove("none");
  fit();
  invoke("find_close");
}

findtext.addEventListener("input", () => invoke("find", { text: findtext.value, step: 0 }));
findtext.addEventListener("keydown", (e) => {
  if (e.key === "Enter") invoke("find", { text: findtext.value, step: e.shiftKey ? -1 : 1 });
  if (e.key === "Escape") closeFind();
});
$("findnext").addEventListener("click", () => invoke("find", { text: findtext.value, step: 1 }));
$("findprev").addEventListener("click", () => invoke("find", { text: findtext.value, step: -1 }));
$("findclose").addEventListener("click", closeFind);

// ---- a page's question (camera, microphone, notifications) ----

/** @param {{ id: number, site: string, what: string }} p */
function showPrompt(p) {
  prompt = p.id;
  $("prompttext").textContent = `${p.site} wants to use your ${p.what}`;
  $("prompt").hidden = false;
  fit();
}

/** @param {boolean} allow */
function answer(allow) {
  if (prompt === null) return;
  const keep = /** @type {HTMLInputElement} */ ($("promptkeep")).checked;
  invoke("prompt_answer", { id: prompt, allow, remember: keep });
  prompt = null;
  $("prompt").hidden = true;
  fit();
}
$("promptyes").addEventListener("click", () => answer(true));
$("promptno").addEventListener("click", () => answer(false));

/** The window gives the chrome the height it needs (rows come and go). */
function fit() {
  let h = 0;
  for (const row of document.querySelectorAll(".row")) {
    if (getComputedStyle(row).display !== "none") h += /** @type {HTMLElement} */ (row).offsetHeight;
  }
  invoke("chrome_height", { height: h });
}

// ---- events from Rust ----

await me.listen("wb:state", (/** @type {{ payload: State }} */ e) => render(e.payload));
await me.listen("wb:downloads", (/** @type {{ payload: Download[] }} */ e) => {
  const fresh = e.payload.some((d) => d.state === "running" && !downloads.some((o) => o.id === d.id));
  renderDownloads(e.payload);
  if (fresh) showDownloads();
});
await me.listen("wb:focus-url", () => {
  if (state?.mode === "full") url.focus();
});
await me.listen("wb:find", openFind);
await me.listen("wb:find-count", (/** @type {{ payload: number }} */ e) => {
  $("findcount").textContent = findtext.value ? `${e.payload} found` : "";
  findtext.classList.toggle("none", !!findtext.value && e.payload === 0);
});
await me.listen("wb:prompt", (/** @type {{ payload: { id: number, site: string, what: string } }} */ e) => showPrompt(e.payload));
await me.listen("wb:open-downloads", showDownloads);
await me.listen("wb:open-menu", () => $("menu").click());

const first = await invoke("chrome_ready");
if (first) render(first);
renderDownloads(await invoke("downloads_list"));
