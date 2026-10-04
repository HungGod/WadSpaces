// @ts-check
// The browser chrome: tabs, toolbar and URL bar. Rust owns the tabs (each is a
// WebKit view under this one); this page draws their state and sends the
// user's actions back as Tauri commands.

/**
 * @typedef {{ id: number, title: string, url: string, loading: boolean, progress: number,
 *             canBack: boolean, canForward: boolean }} TabState
 * @typedef {{ mode: "full" | "focus" | "app", name: string | null, tabs: TabState[],
 *             active: number | null }} State
 */

/** @type {any} */
const T = /** @type {any} */ (window).__TAURI__;
/** @type {(cmd: string, args?: object) => Promise<any>} */
const invoke = T.core.invoke;
const me = T.webviewWindow.getCurrentWebviewWindow();

/** @param {string} id */
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
const tabsEl = $("tabs");
const url = /** @type {HTMLInputElement} */ ($("url"));

/** @type {State | null} */
let state = null;
let editing = false;

/** @param {State} s */
function render(s) {
  state = s;
  document.body.className = `mode-${s.mode}`;
  document.body.classList.toggle("single", s.tabs.length < 2);
  if (s.mode === "full" && $("nav").parentElement !== $("nav-slot")) $("nav-slot").append($("nav"));
  const active = s.tabs.find((t) => t.id === s.active);
  document.body.classList.toggle("loading", !!active?.loading);
  $("progress").style.width = active?.loading ? `${Math.max(5, active.progress * 100)}%` : "0";
  /** @type {HTMLButtonElement} */ ($("back")).disabled = !active?.canBack;
  /** @type {HTMLButtonElement} */ ($("forward")).disabled = !active?.canForward;
  $("appname").textContent = s.name ?? active?.title ?? "";
  document.title = active?.title || s.name || "WadBrowser";
  if (!editing) url.value = display(active?.url ?? "");

  const have = new Map([...tabsEl.children].map((el) => [Number(/** @type {HTMLElement} */ (el).dataset.id), el]));
  const want = s.tabs.map((t) => {
    const el = /** @type {HTMLElement} */ (have.get(t.id) ?? tabEl(t.id));
    have.delete(t.id);
    el.classList.toggle("active", t.id === s.active);
    el.setAttribute("aria-selected", String(t.id === s.active));
    const title = t.title || display(t.url) || "New tab";
    /** @type {HTMLElement} */ (el.querySelector(".title")).textContent = title;
    el.title = title;
    /** @type {HTMLElement} */ (el.querySelector(".spinner")).hidden = !t.loading;
    return el;
  });
  for (const el of have.values()) el.remove();
  want.forEach((el, i) => {
    if (tabsEl.children[i] !== el) tabsEl.insertBefore(el, tabsEl.children[i] ?? null);
  });
}

/** @param {string} u */
function display(u) {
  return u === "about:blank" ? "" : u;
}

/** @param {number} id */
function tabEl(id) {
  const el = document.createElement("div");
  el.className = "tab";
  el.dataset.id = String(id);
  el.setAttribute("role", "tab");
  el.draggable = true;
  el.innerHTML =
    '<span class="spinner" hidden></span><span class="title"></span>' +
    '<button class="x" title="Close tab (Ctrl+W)" aria-label="Close tab">' +
    '<svg viewBox="0 0 16 16"><path d="m4 4 8 8M12 4l-8 8"/></svg></button>';
  el.addEventListener("mousedown", (e) => {
    if (e.button === 1) e.preventDefault();
  });
  el.addEventListener("mouseup", (e) => {
    if (e.button === 1) invoke("tab_close", { id });
  });
  el.addEventListener("click", (e) => {
    if (/** @type {Element} */ (e.target).closest(".x")) invoke("tab_close", { id });
    else invoke("tab_select", { id });
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

for (const zone of [$("strip"), tabsEl]) {
  zone.addEventListener("dragover", (e) => {
    if (!isTabDrag(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    clearDropMarks();
    const i = dropIndex(e);
    const tabs = tabsEl.children;
    if (i < tabs.length) tabs[i].classList.add("drop-before");
    else tabs[tabs.length - 1]?.classList.add("drop-after");
  });
}
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

$("back").addEventListener("click", () => invoke("nav", { action: "back" }));
$("forward").addEventListener("click", () => invoke("nav", { action: "forward" }));
$("reload").addEventListener("click", (e) =>
  invoke("nav", { action: document.body.classList.contains("loading") ? "stop" : e.shiftKey ? "reload-hard" : "reload" }),
);
$("home").addEventListener("click", () => invoke("nav", { action: "home" }));
$("newtab").addEventListener("click", () => invoke("tab_new", {}));
$("min").addEventListener("click", () => invoke("win_action", { action: "minimize" }));
$("max").addEventListener("click", () => invoke("win_action", { action: "maximize" }));
$("close").addEventListener("click", () => invoke("win_action", { action: "close" }));
$("strip").addEventListener("dblclick", (e) => {
  if (/** @type {Element} */ (e.target).hasAttribute("data-tauri-drag-region")) invoke("win_action", { action: "maximize" });
});

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
    url.blur();
    invoke("focus_page");
  }
});
$("urlform").addEventListener("submit", (e) => {
  e.preventDefault();
  editing = false;
  invoke("navigate", { input: url.value });
});

$("menu").addEventListener("click", () => {
  const r = $("menu").getBoundingClientRect();
  const width = 240;
  invoke("popup_show", {
    x: Math.round(r.right - width),
    y: Math.round(r.bottom + 2),
    width,
    // Four items, the box's padding and border, and room for its shadow.
    height: 4 * 32 + 14 + 6,
    kind: "menu",
    data: {
      items: [
        { id: "new-tab", label: "New tab", key: "Ctrl+T" },
        { id: "new-window", label: "New window", key: "Ctrl+N" },
        { id: "fullscreen", label: "Full screen", key: "F11" },
        { id: "downloads", label: "Downloads", key: "" },
      ],
    },
  });
});

await me.listen("wb:state", (/** @type {{ payload: State }} */ e) => render(e.payload));
await me.listen("wb:focus-url", () => {
  if (state?.mode === "full") url.focus();
});
const first = await invoke("chrome_ready");
if (first) render(first);
