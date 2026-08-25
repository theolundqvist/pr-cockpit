const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cockpitShell", {
  openEditor: (repo, number, target) => ipcRenderer.invoke("cockpit:open-editor", { repo, number, target }),
  prepareEditor: (repo, number) => ipcRenderer.invoke("cockpit:prepare-editor", { repo, number }),
  finishEditor: (sessionId) => ipcRenderer.invoke("cockpit:finish-editor", sessionId),
  openSetup: (action) => ipcRenderer.invoke("cockpit:open-setup", action),
  openWindow: (hash) => ipcRenderer.invoke("cockpit:open-window", hash),
  getNativePalette: () => ipcRenderer.invoke("cockpit:native-palette"),
  onNativePaletteChanged: (callback) => {
    const listener = (_event, palette) => callback(palette);
    ipcRenderer.on("cockpit:native-palette-changed", listener);
    return () => ipcRenderer.removeListener("cockpit:native-palette-changed", listener);
  },
});
