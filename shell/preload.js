const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cockpitShell", {
  openEditor: (repo, number, target) => ipcRenderer.invoke("cockpit:open-editor", { repo, number, target }),
  getNativePalette: () => ipcRenderer.invoke("cockpit:native-palette"),
  onNativePaletteChanged: (callback) => {
    const listener = (_event, palette) => callback(palette);
    ipcRenderer.on("cockpit:native-palette-changed", listener);
    return () => ipcRenderer.removeListener("cockpit:native-palette-changed", listener);
  },
});
