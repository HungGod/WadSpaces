const api = window.wadbrowser;
const TAB_DROP_TYPE = "application/x-wadbrowser-tab";

(function applyTitleFromMainQuery() {
  try {
    const t = new URLSearchParams(window.location.search).get("title");
    if (t) document.title = t;
  } catch (_e) {}
})();

const elTabs = document.getElementById("tabs");
const btnBack = document.getElementById("btnBack");
const btnForward = document.getElementById("btnForward");
const btnReload = document.getElementById("btnReload");
const btnHome = document.getElementById("btnHome");
const homeIcon = document.getElementById("homeIcon");
const btnPlus = document.getElementById("btnPlus");
const btnDownloads = document.getElementById("btnDownloads");
const btnMin = document.getElementById("btnMin");
const btnMax = document.getElementById("btnMax");
const btnClose = document.getElementById("btnClose");
const resizeHandle = document.getElementById("resizeHandle");
const linkStatusEl = document.getElementById("linkStatus");

let state = { tabs: [], activeId: null };
let isResizing = false;
const defaultAppConfig = {
  appName: "WadBrowser",
  homeUrl: "about:blank",
  appIconDataUrl: "",
};
let appConfig = { ...defaultAppConfig };
let draggingTabId = null;
let downloadsPanelOpen = false;

function openDownloadsPanel() {
  if (downloadsPanelOpen) {
    downloadsPanelOpen = false;
    api.send("ui:downloadsPanelClose");
  } else {
    downloadsPanelOpen = true;
    api.send("ui:downloadsPanelOpen");
    api.send("ui:downloads");
  }
}

function renderNavButtons() {
  const active = state.tabs.find((t) => t.isActive);
  const canBack = !!(active && active.canGoBack);
  const canFwd = !!(active && active.canGoForward);
  btnBack.disabled = !canBack;
  btnForward.disabled = !canFwd;
}

function reportChromeHeight() {
  const topbar = document.getElementById("topbar");
  if (!topbar) return;
  const h = Math.round(topbar.offsetHeight || 0);
  if (h > 0) api.send("ui:chromeHeight", { height: h });
}

function humanBytes(n) {
  const num = Number(n || 0);
  if (!num) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = num;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function renderTabs() {
  elTabs.innerHTML = "";
  for (const tab of state.tabs) {
    const el = document.createElement("div");
    el.className = `tab noDrag${tab.isActive ? " active" : ""}`;
    el.draggable = true;
    el.dataset.id = tab.id;

    const titleEl = document.createElement("div");
    titleEl.className = "tabTitle";
    const rawTitle = tab.title || "New tab";
    const titleText = rawTitle.length > 12 ? rawTitle.slice(0, 12) + "…" : rawTitle;
    titleEl.textContent = titleText;

    const close = document.createElement("button");
    close.className = "tabClose";
    close.textContent = "×";
    close.title = "Close tab";
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      api.send("tabs:close", { id: tab.id });
    });

    el.addEventListener("click", () => api.send("tabs:select", { id: tab.id }));

    el.addEventListener("dragstart", (e) => {
      draggingTabId = tab.id;
      api.send("tabs:dragStart", { id: tab.id });
      e.dataTransfer.effectAllowed = "move";
      // Custom MIME type so cross-window drop is valid; avoids KDE notepad using text/plain.
      e.dataTransfer.setData("application/x-wadbrowser-tab", tab.id);
      const title = (tab.title || "New tab").slice(0, 12);
      const dragImage = document.createElement("div");
      dragImage.textContent = title + (title.length >= 12 ? "…" : "");
      dragImage.className = "tab";
      dragImage.style.position = "absolute";
      dragImage.style.top = "-1000px";
      dragImage.style.pointerEvents = "none";
      document.body.appendChild(dragImage);
      e.dataTransfer.setDragImage(dragImage, 0, 0);
      setTimeout(() => dragImage.remove(), 0);
    });
    el.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    });
    el.addEventListener("drop", (e) => {
      e.preventDefault();
      const draggedId =
        e.dataTransfer.getData(TAB_DROP_TYPE) ||
        e.dataTransfer.getData("text/plain") ||
        draggingTabId;
      const targetId = tab.id;
      if (!draggedId || draggedId === targetId) return;
      const ids = state.tabs.map((t) => t.id);
      const from = ids.indexOf(draggedId);
      const to = ids.indexOf(targetId);
      if (from < 0 || to < 0) return;
      ids.splice(from, 1);
      ids.splice(to, 0, draggedId);
      api.send("tabs:reorder", { ids });
      draggingTabId = null;
    });

    el.addEventListener("dragend", () => {
      api.send("tabs:dragEnd", { id: tab.id });
      if (draggingTabId === tab.id) {
        api.send("tabs:detach", { id: tab.id });
        draggingTabId = null;
      }
    });

    el.appendChild(titleEl);
    el.appendChild(close);
    elTabs.appendChild(el);
  }
}

btnHome.addEventListener("click", () => api.send("nav:home"));
btnPlus.addEventListener("click", () => api.send("tabs:new", {}));
btnDownloads.addEventListener("click", () => openDownloadsPanel());

btnBack.addEventListener("click", () => api.send("nav:back"));
btnForward.addEventListener("click", () => api.send("nav:forward"));
btnReload.addEventListener("click", () => api.send("nav:reload"));

btnMin.addEventListener("click", () => api.send("win:minimize"));
btnMax.addEventListener("click", () => api.send("win:maximizeToggle"));
btnClose.addEventListener("click", () => api.send("win:close"));

if (resizeHandle) {
  resizeHandle.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    isResizing = true;
    api.send("win:resizeStart");
  });
}
document.addEventListener("mousemove", (e) => {
  if (!isResizing) return;
  api.send("win:resizeMove", { screenX: e.screenX, screenY: e.screenY });
});
document.addEventListener("mouseup", () => {
  if (!isResizing) return;
  isResizing = false;
  api.send("win:resizeEnd");
});

api.on("tabs:state", (data) => {
  state = data || { tabs: [], activeId: null };
  renderTabs();
  renderNavButtons();
});

api.on("app:config", (data) => {
  const incoming = data && typeof data === "object" ? data : {};
  const defined = Object.fromEntries(Object.entries(incoming).filter(([, v]) => v !== undefined));
  appConfig = { ...defaultAppConfig, ...appConfig, ...defined };
  document.title = api.formatWindowTitle(appConfig.appName);
  const src = appConfig.appIconDataUrl || "";
  if (src) {
    homeIcon.src = src;
  } else {
    homeIcon.src =
      "data:image/svg+xml;utf8," +
      encodeURIComponent(
        `<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"18\" height=\"18\" viewBox=\"0 0 24 24\"><path fill=\"#E8EAED\" d=\"M12 3 3 11h2v9h6v-6h2v6h6v-9h2z\"/></svg>`
      );
  }
  reportChromeHeight();
});

api.on("win:state", (data) => {
  const maximized = !!(data && data.maximized);
  const fullscreen = !!(data && data.fullscreen);
  btnMax.textContent = maximized || fullscreen ? "❐" : "□";
  btnMax.title = fullscreen ? "Exit fullscreen" : maximized ? "Restore" : "Maximize";
});

api.on("app:linkStatus", (data) => {
  if (!linkStatusEl) return;
  const url = data && data.url ? data.url : "";
  linkStatusEl.textContent = url;
  linkStatusEl.title = url;
});

api.on("tray:newTab", () => api.send("tabs:new", {}));
api.on("ui:downloadsPanelClosed", () => {
  downloadsPanelOpen = false;
});
api.on("tray:downloads", () => {
  if (!downloadsPanelOpen) openDownloadsPanel();
  else api.send("ui:downloads");
});


window.addEventListener("resize", () => reportChromeHeight());
window.addEventListener("DOMContentLoaded", () => {
  reportChromeHeight();
  setTimeout(reportChromeHeight, 0);
  setTimeout(reportChromeHeight, 250);
});

document.addEventListener("dragover", (e) => {
  if (draggingTabId) {
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  if (e.dataTransfer.types && e.dataTransfer.types.includes(TAB_DROP_TYPE)) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }
});

document.addEventListener("drop", (e) => {
  if (draggingTabId) {
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  if (e.dataTransfer.types && e.dataTransfer.types.includes(TAB_DROP_TYPE)) {
    e.preventDefault();
    e.stopPropagation();
  }
});

const tabStrip = document.getElementById("tabStrip");
if (tabStrip) {
  tabStrip.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
  });
  tabStrip.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    api.send("tabs:dropFromExternal");
  });
}

