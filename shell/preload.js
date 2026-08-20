const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cockpitShell", {
  openEditor: (repo, number, target) => ipcRenderer.invoke("cockpit:open-editor", { repo, number, target }),
});
