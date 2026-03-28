const path = require("path");
const os = require("os");
const fs = require("fs");

const {
  app,
  BrowserWindow,
  BrowserView,
  ipcMain,
  Menu,
  clipboard,
  shell,
  session,
  nativeImage,
  screen,
} = require("electron");

const { loadConfig, slugify, formatWindowTitle } = require("./shared/config");

let isQuitting = false;

/** win.id -> { win, tabs, homeUrl, appName, iconPath, ... } for cross-window tab docking */
const windowRegistry = new Map();
/** { sourceWin, sourceTabId } while a tab is being dragged */
let globalTabDrag = null;
/** { sourceWinId, sourceTabId } after a tab was docked into another window (so tabs:detach does not create a new window) */
let lastDocked = null;
/** { win, initialBounds, initialPoint } while user is resizing via the corner handle */
let resizeState = null;

function parseArgv(argv) {
  const out = { configPath: "", url: "" };
  /** Electron passes the app directory as the first arg after the binary (same as process.argv[1]); never treat it as a URL. */
  let skipPositionalAsUrl = "";
  try {
    if (process.argv[1]) skipPositionalAsUrl = path.resolve(process.argv[1]);
  } catch (_e) {}
  const mainDir = path.resolve(__dirname);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--config" || a === "-c") {
      out.configPath = argv[i + 1] || "";
      i++;
      continue;
    }
    if (a.startsWith("--config=")) {
      out.configPath = a.slice("--config=".length);
      continue;
    }
    if (a === "--url" || a === "-u") {
      out.url = argv[i + 1] || "";
      i++;
      continue;
    }
    if (a.startsWith("--url=")) {
      out.url = a.slice("--url=".length);
      continue;
    }
    if (!a.startsWith("-") && !out.url && a !== ".") {
      try {
        const resolved = path.resolve(a);
        if (skipPositionalAsUrl && resolved === skipPositionalAsUrl) continue;
        if (resolved === mainDir) continue;
      } catch (_e) {}
      out.url = a;
    }
  }
  return out;
}

function normalizeUrl(url) {
  if (!url) return "about:blank";
  if (/^(https?:|file:|about:)/i.test(url)) return url;
  return `https://${url}`;
}

function ensureDir(p) {
  try {
    fs.mkdirSync(p, { recursive: true });
  } catch (_e) {}
}

function makeDownloadDir(appName) {
  const slug = slugify(appName);
  const base = path.join(os.homedir(), ".wadbrowser", slug, "downloads");
  ensureDir(base);
  return base;
}

function getIconDataUrl(iconPath) {
  if (!iconPath) return "";
  try {
    const ext = String(path.extname(iconPath)).toLowerCase();
    if (ext === ".svg") {
      const svg = fs.readFileSync(iconPath, "utf-8");
      return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
    }
    const buf = fs.readFileSync(iconPath);
    const b64 = buf.toString("base64");
    return `data:image/png;base64,${b64}`;
  } catch (_e) {
    return "";
  }
}

class TabManager {
  constructor(win, homeUrl, downloadDir, getChromeHeight, afterAttach = null) {
    this.win = win;
    this.homeUrl = homeUrl;
    this.downloadDir = downloadDir;
    this.getChromeHeight = getChromeHeight;
    this.afterAttach = afterAttach;
    this.tabs = []; // [{id, title, view}]
    this.activeId = null;
    this.nextId = 1;
    this.activeView = null;
  }

  _sendState() {
    const list = this.tabs.map((t) => {
      const wc = t.view.webContents;
      const nh = wc.navigationHistory;
      const canGoBack = nh ? nh.canGoBack() : wc.canGoBack();
      const canGoForward = nh ? nh.canGoForward() : wc.canGoForward();
      return {
        id: t.id,
        title: t.title || "New tab",
        canGoBack,
        canGoForward,
        isActive: t.id === this.activeId,
      };
    });
    this.win.webContents.send("tabs:state", { tabs: list, activeId: this.activeId });
  }

  _attachView(view) {
    if (this.activeView && this.activeView !== view) {
      try {
        this.win.removeBrowserView(this.activeView);
      } catch (_e) {}
    }
    this.activeView = view;
    try {
      const views = this.win.getBrowserViews();
      if (!views.includes(view)) this.win.addBrowserView(view);
    } catch (_e) {
      // Fallback for older Electron behavior
      this.win.setBrowserView(view);
    }
    const [w, h] = this.win.getContentSize();
    const chromeHeight = this.getChromeHeight();
    view.setBounds({ x: 0, y: chromeHeight, width: w, height: Math.max(0, h - chromeHeight) });
    view.setAutoResize({ width: true, height: true });
    if (typeof this.afterAttach === "function") this.afterAttach();
  }

  _detachView() {
    if (!this.activeView) {
      this.win.setBrowserView(null);
      return;
    }
    try {
      this.win.removeBrowserView(this.activeView);
    } catch (_e) {
      this.win.setBrowserView(null);
    }
    this.activeView = null;
  }

  _wireWebContents(tab) {
    const wc = tab.view.webContents;
    wc.setMaxListeners(64);
    wc.on("page-title-updated", (_evt, title) => {
      tab.title = title || tab.title;
      this._sendState();
    });
    const navChanged = () => this._sendState();
    wc.on("did-navigate", navChanged);
    wc.on("did-navigate-in-page", navChanged);
    wc.on("did-start-loading", navChanged);
    wc.on("did-stop-loading", navChanged);

    wc.on("did-finish-load", () => {
      wc
        .executeJavaScript(
          `(function(){window.__wadLinkHref=null;document.addEventListener("mouseover",function(e){var a=e.target.closest("a");window.__wadLinkHref=(a&&a.href)?a.href:null;},true);document.addEventListener("mouseout",function(e){if(!e.relatedTarget||!document.contains(e.relatedTarget))window.__wadLinkHref=null;else{var a=e.target.closest("a");var toA=e.relatedTarget?e.relatedTarget.closest("a"):null;if(!a||a!==toA)window.__wadLinkHref=null;}},true);})();`
        )
        .catch(() => {});
    });

    wc.on("context-menu", (_event, params) => {
      const template = [];
      if (params.mediaType === "image" && params.srcURL) {
        template.push({
          label: "Save image",
          click: () => wc.downloadURL(params.srcURL),
        });
        template.push({ type: "separator" });
      }
      if (params.linkURL) {
        template.push({
          label: "Open link in new tab",
          click: () => this.newTab(params.linkURL, true),
        });
        template.push({
          label: "Copy link",
          click: () => clipboard.writeText(params.linkURL),
        });
        template.push({ type: "separator" });
      }
      if (params.selectionText) {
        template.push({
          label: "Copy",
          click: () => clipboard.writeText(params.selectionText),
        });
      } else {
        template.push({ role: "copy", label: "Copy" });
      }
      const menu = Menu.buildFromTemplate(template);
      menu.popup({ window: this.win });
    });

    wc.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown") return;
      if (input.key === "F11") {
        event.preventDefault();
        const win = this.win;
        win.setFullScreen(!win.isFullScreen());
        win.webContents.send("win:state", { maximized: win.isMaximized(), fullscreen: win.isFullScreen() });
        return;
      }
      if ((input.control || input.meta) && (input.key === "t" || input.key === "T")) {
        event.preventDefault();
        this.newTab(this.homeUrl, true);
        return;
      }
      if ((input.control || input.meta) && (input.key === "w" || input.key === "W")) {
        event.preventDefault();
        this.closeTab(this.activeId);
      }
    });
  }

  newTab(url, makeActive) {
    const id = String(this.nextId++);
    const view = new BrowserView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    const tab = { id, title: "New tab", view };
    this._wireWebContents(tab);
    this.tabs.push(tab);
    view.webContents.loadURL(normalizeUrl(url || this.homeUrl));
    if (makeActive) this.selectTab(id);
    this._sendState();
    return id;
  }

  selectTab(id) {
    const next = this.tabs.find((t) => t.id === id);
    if (!next) return;
    if (this.activeId === id) return;
    this.activeId = id;
    this._attachView(next.view);
    this._sendState();
  }

  reorderTabs(ids) {
    const map = new Map(this.tabs.map((t) => [t.id, t]));
    const reordered = [];
    for (const id of ids) {
      const t = map.get(id);
      if (t) reordered.push(t);
      map.delete(id);
    }
    for (const t of map.values()) reordered.push(t);
    this.tabs = reordered;
    this._sendState();
  }

  /** Remove a tab. Options: { createNewIfEmpty: true } — if no tabs left, create a new one (default true). */
  removeTab(id, options = {}) {
    if (!id) return;
    const idx = this.tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const [tab] = this.tabs.splice(idx, 1);
    if (this.activeId === id) {
      this._detachView();
      const next = this.tabs[Math.max(0, idx - 1)] || this.tabs[0] || null;
      this.activeId = null;
      if (next) this.selectTab(next.id);
    }
    try {
      tab.view.webContents.destroy();
    } catch (_e) {}
    if (this.tabs.length === 0 && options.createNewIfEmpty !== false) {
      this.newTab(this.homeUrl, true);
    }
    this._sendState();
  }

  closeTab(id) {
    const isLast = this.tabs.length === 1 && this.tabs[0] && this.tabs[0].id === id;
    this.removeTab(id, { createNewIfEmpty: false });
    if (isLast && !this.win.isDestroyed()) {
      this.win.close();
    }
  }

  activeWebContents() {
    const tab = this.tabs.find((t) => t.id === this.activeId);
    return tab ? tab.view.webContents : null;
  }

  goBack() {
    const wc = this.activeWebContents();
    if (!wc) return;
    const nh = wc.navigationHistory;
    if (nh ? nh.canGoBack() : wc.canGoBack()) {
      wc.goBack();
    }
  }

  goForward() {
    const wc = this.activeWebContents();
    if (!wc) return;
    const nh = wc.navigationHistory;
    if (nh ? nh.canGoForward() : wc.canGoForward()) {
      wc.goForward();
    }
  }

  reload() {
    const wc = this.activeWebContents();
    if (wc) wc.reload();
  }

  home() {
    const wc = this.activeWebContents();
    if (wc) wc.loadURL(normalizeUrl(this.homeUrl));
  }
}

function setupDownloads(win, appName, getPanelWebContents) {
  const downloadDir = makeDownloadDir(appName);
  const downloads = []; // [{id, filename, receivedBytes, totalBytes, state, path}]
  const activeItems = new Map(); // id -> item
  let nextId = 1;

  const getPanelWC = typeof getPanelWebContents === "function" ? getPanelWebContents : () => null;
  const send = () => {
    win.webContents.send("downloads:state", { downloads });
    const pw = getPanelWC();
    if (pw && !pw.isDestroyed()) pw.send("downloads:state", { downloads });
  };

  session.defaultSession.on("will-download", (_event, item) => {
    const id = String(nextId++);
    const filename = item.getFilename();
    const savePath = path.join(downloadDir, filename);
    item.setSavePath(savePath);
    activeItems.set(id, item);
    const entry = {
      id,
      filename,
      receivedBytes: 0,
      totalBytes: item.getTotalBytes(),
      state: "progressing",
      path: savePath,
    };
    downloads.unshift(entry);
    send();

    item.on("updated", () => {
      entry.receivedBytes = item.getReceivedBytes();
      entry.totalBytes = item.getTotalBytes();
      entry.state = item.isPaused() ? "paused" : "progressing";
      send();
    });
    item.once("done", (_e, state) => {
      entry.receivedBytes = item.getReceivedBytes();
      entry.totalBytes = item.getTotalBytes();
      entry.state = state;
      activeItems.delete(id);
      send();
    });
  });

  ipcMain.on("downloads:openFolder", (_evt, payload) => {
    const p = payload && payload.path ? payload.path : "";
    if (p) shell.showItemInFolder(p);
  });
  ipcMain.on("downloads:remove", (_evt, payload) => {
    const id = payload && payload.id ? payload.id : "";
    const idx = downloads.findIndex((d) => d.id === id);
    if (idx >= 0) downloads.splice(idx, 1);
    send();
  });
  ipcMain.on("downloads:cancel", (_evt, payload) => {
    const id = payload && payload.id ? payload.id : "";
    const item = activeItems.get(id);
    if (item) item.cancel();
  });

  return { downloadDir, send };
}

function createWindowInternal(appName, homeUrl, iconPath) {
  const iconDataUrl = getIconDataUrl(iconPath);

  let chromeHeight = 44;
  const getChromeHeight = () => chromeHeight;
  const PANEL_W = 320;
  const PANEL_H = 205;
  let downloadsOverlayView = null;
  let unmaximizeAfterLeaveFullScreen = false;
  const getPanelWebContents = () =>
    downloadsOverlayView && !downloadsOverlayView.webContents.isDestroyed() ? downloadsOverlayView.webContents : null;

  const windowTitle = formatWindowTitle(appName);
  const win = new BrowserWindow({
    width: 1100,
    height: 750,
    title: windowTitle,
    icon: iconPath || undefined,
    frame: false,
    titleBarStyle: "hidden",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
    },
  });
  win.setMaxListeners(64);

  win.webContents.on("page-title-updated", () => {
    if (!win.isDestroyed()) win.setTitle(windowTitle);
  });

  win.loadFile(path.join(__dirname, "renderer", "index.html"), {
    query: { title: windowTitle },
  });

  const downloadsCtl = setupDownloads(win, appName, getPanelWebContents);
  const positionDownloadsOverlay = () => {
    if (!downloadsOverlayView) return;
    const [w] = win.getContentSize();
    downloadsOverlayView.setBounds({
      x: Math.max(0, w - PANEL_W - 12),
      y: chromeHeight + 6,
      width: PANEL_W,
      height: PANEL_H,
    });
  };
  const ensureOverlayOnTop = () => {
    if (!downloadsOverlayView) return;
    try {
      win.setTopBrowserView(downloadsOverlayView);
    } catch (_e) {
      // ignore
    }
  };
  const tabs = new TabManager(win, homeUrl, downloadsCtl.downloadDir, getChromeHeight, ensureOverlayOnTop);

  win.on("resize", () => {
    const tab = tabs.tabs.find((t) => t.id === tabs.activeId);
    if (!tab) return;
    const [w, h] = win.getContentSize();
    const ch = getChromeHeight();
    tab.view.setBounds({ x: 0, y: ch, width: w, height: Math.max(0, h - ch) });
    positionDownloadsOverlay();
    ensureOverlayOnTop();
  });

  win.on("maximize", () => win.webContents.send("win:state", { maximized: true, fullscreen: win.isFullScreen() }));
  win.on("unmaximize", () =>
    win.webContents.send("win:state", { maximized: false, fullscreen: win.isFullScreen() })
  );
  win.on("enter-full-screen", () =>
    win.webContents.send("win:state", { maximized: win.isMaximized(), fullscreen: true })
  );
  win.on("leave-full-screen", () => {
    if (unmaximizeAfterLeaveFullScreen) {
      unmaximizeAfterLeaveFullScreen = false;
      if (!win.isDestroyed() && win.isMaximized()) win.unmaximize();
    }
    if (!win.isDestroyed()) win.webContents.send("win:state", { maximized: win.isMaximized(), fullscreen: false });
  });

  win.on("close", (e) => {
    const windows = BrowserWindow.getAllWindows();
    if (!isQuitting && windows.length === 1) {
      e.preventDefault();
      isQuitting = true;
      app.quit();
    }
  });

  win.on("closed", () => {
    clearInterval(linkStatusInterval);
    if (downloadsOverlayView && !downloadsOverlayView.webContents.isDestroyed()) {
      try {
        win.removeBrowserView(downloadsOverlayView);
      } catch (_e) {}
      try {
        downloadsOverlayView.webContents.destroy();
      } catch (_e) {}
      downloadsOverlayView = null;
    }
    windowRegistry.delete(win.id);
  });

  windowRegistry.set(win.id, { win, tabs, homeUrl, appName, iconPath });

  const guard = () => win.isDestroyed();

  ipcMain.on("tabs:new", (event, payload) => {
    if (guard()) return;
    if (event.sender !== win.webContents) return;
    const url = payload && payload.url ? payload.url : "";
    tabs.newTab(url || homeUrl, true);
  });
  ipcMain.on("tabs:select", (event, payload) => {
    if (guard()) return;
    if (event.sender !== win.webContents) return;
    tabs.selectTab(payload && payload.id);
  });
  ipcMain.on("tabs:close", (event, payload) => {
    if (guard()) return;
    if (event.sender !== win.webContents) return;
    tabs.closeTab(payload && payload.id);
  });
  ipcMain.on("tabs:reorder", (event, payload) => {
    if (guard()) return;
    if (event.sender !== win.webContents) return;
    tabs.reorderTabs((payload && payload.ids) || []);
  });

  ipcMain.on("nav:back", (event) => {
    if (guard()) return;
    if (event.sender !== win.webContents) return;
    tabs.goBack();
  });
  ipcMain.on("nav:forward", (event) => {
    if (guard()) return;
    if (event.sender !== win.webContents) return;
    tabs.goForward();
  });
  ipcMain.on("nav:reload", (event) => {
    if (guard()) return;
    if (event.sender !== win.webContents) return;
    tabs.reload();
  });
  ipcMain.on("nav:home", (event) => {
    if (guard()) return;
    if (event.sender !== win.webContents) return;
    tabs.home();
  });

  ipcMain.on("ui:downloads", (event) => {
    if (guard()) return;
    if (event.sender !== win.webContents) return;
    downloadsCtl.send();
  });

  ipcMain.on("ui:downloadsPanelOpen", (event) => {
    if (guard()) return;
    if (event.sender !== win.webContents) return;
    if (downloadsOverlayView && !downloadsOverlayView.webContents.isDestroyed()) {
      positionDownloadsOverlay();
      ensureOverlayOnTop();
      downloadsCtl.send();
      return;
    }
    downloadsOverlayView = new BrowserView({
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    downloadsOverlayView.webContents.setMaxListeners(64);
    win.addBrowserView(downloadsOverlayView);
    positionDownloadsOverlay();
    ensureOverlayOnTop();
    downloadsOverlayView.webContents.loadFile(path.join(__dirname, "renderer", "downloads-panel.html"));
    downloadsOverlayView.webContents.once("did-finish-load", () => downloadsCtl.send());
  });
  ipcMain.on("ui:downloadsPanelClose", (event) => {
    if (guard()) return;
    const fromMain = event.sender === win.webContents;
    const fromOverlay = downloadsOverlayView && downloadsOverlayView.webContents === event.sender;
    if (!fromMain && !fromOverlay) return;
    if (!downloadsOverlayView) return;
    try {
      win.removeBrowserView(downloadsOverlayView);
    } catch (_e) {}
    try {
      downloadsOverlayView.webContents.destroy();
    } catch (_e) {}
    downloadsOverlayView = null;
    if (fromOverlay) win.webContents.send("ui:downloadsPanelClosed");
  });

  ipcMain.on("ui:chromeHeight", (event, payload) => {
    if (guard()) return;
    if (event.sender !== win.webContents) return;
    const h = payload && typeof payload.height === "number" ? payload.height : 0;
    if (h > 20 && h < 200) {
      chromeHeight = Math.round(h);
      const tab = tabs.tabs.find((t) => t.id === tabs.activeId);
      if (tab) {
        const [w, hh] = win.getContentSize();
        tab.view.setBounds({ x: 0, y: chromeHeight, width: w, height: Math.max(0, hh - chromeHeight) });
      }
      positionDownloadsOverlay();
      ensureOverlayOnTop();
    }
  });

  ipcMain.on("win:minimize", (event) => {
    if (guard()) return;
    if (event.sender !== win.webContents) return;
    win.minimize();
  });
  ipcMain.on("win:maximizeToggle", (event) => {
    if (guard()) return;
    if (event.sender !== win.webContents) return;
    if (win.isFullScreen()) {
      unmaximizeAfterLeaveFullScreen = true;
      win.setFullScreen(false);
      return;
    }
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
    win.webContents.send("win:state", { maximized: win.isMaximized(), fullscreen: win.isFullScreen() });
  });
  ipcMain.on("win:resizeStart", (event) => {
    if (guard()) return;
    if (event.sender !== win.webContents) return;
    const point = screen.getCursorScreenPoint();
    resizeState = {
      win,
      initialBounds: win.getBounds(),
      initialPoint: { x: point.x, y: point.y },
    };
  });

  ipcMain.on("win:close", (event) => {
    if (guard()) return;
    if (event.sender !== win.webContents) return;
    const windows = BrowserWindow.getAllWindows();
    if (windows.length === 1) {
      isQuitting = true;
      app.quit();
    } else {
      win.close();
    }
  });

  ipcMain.on("tabs:detach", (event, payload) => {
    if (guard()) return;
    if (event.sender !== win.webContents) return;
    const id = payload && payload.id ? payload.id : "";
    if (!id) return;
    if (lastDocked && win.id === lastDocked.sourceWinId && id === lastDocked.sourceTabId) {
      lastDocked = null;
      return;
    }
    const tab = tabs.tabs.find((t) => t.id === id);
    if (!tab) return;
    const wc = tab.view.webContents;
    const url = wc.getURL();
    tabs.removeTab(id, { createNewIfEmpty: false });
    createWindowInternal(appName, url || homeUrl, iconPath);
    if (tabs.tabs.length === 0) {
      win.close();
    }
  });

  const linkStatusInterval = setInterval(() => {
    if (win.isDestroyed()) return;
    const tab = tabs.tabs.find((t) => t.id === tabs.activeId);
    if (!tab) return;
    const wc = tab.view.webContents;
    wc
      .executeJavaScript("window.__wadLinkHref || null")
      .then((href) => {
        const safe = JSON.stringify(String(href || ""));
        wc
          .executeJavaScript(
            `(function(){if(!document.body)return;var u=${safe};var el=window.__wadLinkStatusEl;if(!el){el=document.createElement('div');el.id='wad-link-status';document.body.appendChild(el);window.__wadLinkStatusEl=el;}el.textContent=u;el.style.cssText=u?'position:fixed;left:8px;bottom:8px;z-index:2147483647;background:rgba(0,0,0,0.82);color:#bdc1c6;padding:4px 8px;border-radius:4px;font:11px system-ui,sans-serif;max-width:80%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;pointer-events:none;':'display:none;';})();`
          )
          .catch(() => {});
      })
      .catch(() => {});
  }, 200);

  win.webContents.on("did-finish-load", () => {
    win.setTitle(windowTitle);
    win.webContents.send("app:config", { appName, homeUrl, appIconDataUrl: iconDataUrl });
    win.webContents.send("win:state", { maximized: win.isMaximized(), fullscreen: win.isFullScreen() });
    tabs.newTab(homeUrl, true);
    downloadsCtl.send();
  });

  return win;
}

function createWindow(initialUrl) {
  const argv = parseArgv(process.argv.slice(1));
  const cfg = loadConfig(argv.configPath);
  const appName = cfg.app_name || "WadBrowser";
  const baseHomeUrl = normalizeUrl(argv.url || cfg.app_url || "about:blank");
  const homeUrl = normalizeUrl(initialUrl || baseHomeUrl);
  const iconPath = cfg.icon_path && fs.existsSync(cfg.icon_path) ? cfg.icon_path : null;
  return createWindowInternal(appName, homeUrl, iconPath);
}

/** When launched with --config (packaged mini-apps), give each app a distinct WM_CLASS and userData so the taskbar/dock shows separate entries (Linux/Wayland). */
function applyPackagedInstanceIdentity(argv, cfg) {
  if (!argv.configPath) return;
  const name = cfg.app_name || "WadBrowser";
  const wmClass = (cfg.wm_class && String(cfg.wm_class).trim()) || slugify(name);
  try {
    app.setName(name);
  } catch (_e) {}
  if (process.platform === "linux") {
    /** Same role as Qt QGuiApplication::setDesktopFileName: sets CHROME_DESKTOP so the shell/task manager matches the installed .desktop id (see Electron init + Wayland app_id). */
    const desktopFile =
      (cfg.desktop_file && String(cfg.desktop_file).trim()) ||
      (wmClass ? `${wmClass}.desktop` : "");
    if (desktopFile && typeof app.setDesktopName === "function") {
      try {
        app.setDesktopName(desktopFile);
      } catch (_e) {}
    }
    app.commandLine.appendSwitch("class", wmClass);
  }
  const userDataPath = path.join(os.homedir(), ".wadbrowser", wmClass, "electron-user-data");
  try {
    fs.mkdirSync(userDataPath, { recursive: true });
  } catch (_e) {}
  try {
    app.setPath("userData", userDataPath);
  } catch (_e) {}
}

const argvBootstrap = parseArgv(process.argv.slice(1));
applyPackagedInstanceIdentity(argvBootstrap, loadConfig(argvBootstrap.configPath));

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

// Suppress systemd scope "UnitExists" when Chromium creates a transient unit (non-fatal).
app.commandLine.appendSwitch("disable-namespace-sandbox");
// VA-API is left enabled so hardware video decode is used when available. If you see
// "vaInitialize failed" in AppImage/sandbox, install libva and your GPU driver
// (e.g. mesa-va-drivers, intel-media-driver) for acceleration; the app still runs with software decode.

app.whenReady().then(() => {
  ipcMain.on("tabs:dragStart", (_event, payload) => {
    const id = payload && payload.id ? payload.id : "";
    if (!id) return;
    const w = BrowserWindow.fromWebContents(_event.sender);
    if (!w) return;
    globalTabDrag = { sourceWin: w, sourceTabId: id };
  });
  ipcMain.on("tabs:dragEnd", () => {
    globalTabDrag = null;
  });
  ipcMain.on("win:resizeMove", (event, payload) => {
    if (!resizeState || resizeState.win.isDestroyed()) return;
    if (event.sender !== resizeState.win.webContents) return;
    const x = payload && typeof payload.screenX === "number" ? payload.screenX : resizeState.initialPoint.x;
    const y = payload && typeof payload.screenY === "number" ? payload.screenY : resizeState.initialPoint.y;
    const dx = x - resizeState.initialPoint.x;
    const dy = y - resizeState.initialPoint.y;
    const MIN_W = 400;
    const MIN_H = 300;
    const w = Math.max(MIN_W, resizeState.initialBounds.width + dx);
    const h = Math.max(MIN_H, resizeState.initialBounds.height + dy);
    resizeState.win.setBounds({
      x: resizeState.initialBounds.x,
      y: resizeState.initialBounds.y,
      width: w,
      height: h,
    });
  });
  ipcMain.on("win:resizeEnd", () => {
    resizeState = null;
  });

  ipcMain.on("tabs:dropFromExternal", (event) => {
    const dropWin = BrowserWindow.fromWebContents(event.sender);
    if (!dropWin) return;
    const dropState = windowRegistry.get(dropWin.id);
    if (!dropState) return;
    if (!globalTabDrag) return;
    if (globalTabDrag.sourceWin.id === dropWin.id) return;
    if (globalTabDrag.sourceWin.isDestroyed()) return;
    const sourceState = windowRegistry.get(globalTabDrag.sourceWin.id);
    if (!sourceState) return;
    const tab = sourceState.tabs.tabs.find((t) => t.id === globalTabDrag.sourceTabId);
    if (!tab) return;
    let url;
    try {
      url = tab.view.webContents.getURL();
    } catch (_e) {
      return;
    }
    dropState.tabs.newTab(url || dropState.homeUrl, true);
    sourceState.tabs.removeTab(globalTabDrag.sourceTabId, { createNewIfEmpty: false });
    if (sourceState.tabs.tabs.length === 0) {
      globalTabDrag.sourceWin.close();
    }
    lastDocked = { sourceWinId: globalTabDrag.sourceWin.id, sourceTabId: globalTabDrag.sourceTabId };
    globalTabDrag = null;
  });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  // Quit on all platforms when the last window is closed.
  app.quit();
});

app.on("before-quit", () => {
  isQuitting = true;
});
