// The only bridge between the UI and the shell: "this is the desktop app",
// and the "I started" signal (logged by main.cjs).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("wadcreator", {
  shell: true,
  /** Call once the UI has rendered. */
  ready: () => ipcRenderer.send("app:ready"),
});
