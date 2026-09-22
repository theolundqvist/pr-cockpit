const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cockpitShell", {
  openEditor: (repo, number, target, headSha) => ipcRenderer.invoke("cockpit:open-editor", { repo, number, target, headSha }),
  prepareEditor: (repo, number, headSha) => ipcRenderer.invoke("cockpit:prepare-editor", { repo, number, headSha }),
  finishEditor: (sessionId) => ipcRenderer.invoke("cockpit:finish-editor", sessionId),
  openSetup: (action) => ipcRenderer.invoke("cockpit:open-setup", action),
  installGit: () => ipcRenderer.invoke("cockpit:install-git"),
  openDataFolder: () => ipcRenderer.invoke("cockpit:open-data-folder"),
  openWindow: (hash) => ipcRenderer.invoke("cockpit:open-window", hash),
  getNativePalette: () => ipcRenderer.invoke("cockpit:native-palette"),
  onNativePaletteChanged: (callback) => {
    const listener = (_event, palette) => callback(palette);
    ipcRenderer.on("cockpit:native-palette-changed", listener);
    return () => ipcRenderer.removeListener("cockpit:native-palette-changed", listener);
  },
});
