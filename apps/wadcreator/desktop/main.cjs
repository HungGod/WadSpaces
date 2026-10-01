// Wad Creator desktop app: the offline half of Wad Creator. On a WadSpaces
// machine wadd starts it in the kiosk session (POST /api/apps/wadcreator/open)
// as a window of its own, and it manages that machine through wadd on
// 127.0.0.1:8080. The UI is the shared React app built with VITE_TARGET=offline
// into ./renderer, and it updates with the host image (the USB stick).
//
// It is served from app://wadcreator/ rather than file://, so its requests
// carry a stable Origin that wadd trusts (file:// pages send "null").
const { app, BrowserWindow, ipcMain, net, protocol } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const BUILTIN = path.join(__dirname, "renderer");

protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

// One window, however many times wadd asks for it.
if (!app.requestSingleInstanceLock()) app.quit();

let win;

function serve(request) {
  const { pathname } = new URL(request.url);
  let file = path.normalize(path.join(BUILTIN, decodeURIComponent(pathname)));
  if (file !== BUILTIN && !file.startsWith(BUILTIN + path.sep)) {
    return new Response("not found", { status: 404 });
  }
  // Client-side routes (/wadspaces, /builder/x) all load the app.
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(BUILTIN, "index.html");
  return net.fetch(pathToFileURL(file).toString());
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: "Wad Creator",
    backgroundColor: "#0a0614",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });
  win.removeMenu();
  // There is no browser on the machine to hand links to.
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.loadURL("app://wadcreator/");
}

// Only our own page may talk to the shell.
const fromApp = (e) => (e.senderFrame?.url ?? "").startsWith("app://wadcreator/");

ipcMain.on("app:ready", (e) => {
  if (fromApp(e)) console.log("wadcreator: UI started");
});

app.whenReady().then(() => {
  // UI bundles an older version downloaded over the air; nothing reads them now.
  try {
    fs.rmSync(path.join(app.getPath("userData"), "bundles"), { recursive: true, force: true });
  } catch {}
  protocol.handle("app", serve);
  createWindow();
  app.on("second-instance", () => {
    if (win.isMinimized()) win.restore();
    win.focus();
  });
});

app.on("window-all-closed", () => app.quit());
