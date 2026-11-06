import { contextBridge, ipcRenderer } from "electron";

// Narrow, typed surface. Add methods here deliberately; never expose ipcRenderer itself.
contextBridge.exposeInMainWorld("solo", {
  version: (): Promise<string> => ipcRenderer.invoke("solo:version"),
});
