const { contextBridge, ipcRenderer } = require("electron");
const { formatWindowTitle } = require("./shared/config");

contextBridge.exposeInMainWorld("wadbrowser", {
  send: (channel, payload) => ipcRenderer.send(channel, payload),
  on: (channel, handler) => {
    const wrapped = (_event, data) => handler(data);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
  formatWindowTitle,
});

