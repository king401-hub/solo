import { contextBridge, ipcRenderer } from "electron";
import type { LinkSnapshot } from "../main/link/service";

// Narrow, typed surface. Add methods here deliberately; never expose ipcRenderer itself.
contextBridge.exposeInMainWorld("solo", {
  version: (): Promise<string> => ipcRenderer.invoke("solo:version"),
  link: {
    snapshot: (): Promise<LinkSnapshot> => ipcRenderer.invoke("link:snapshot"),
    startPairing: (): Promise<LinkSnapshot> => ipcRenderer.invoke("link:startPairing"),
    cancelPairing: (): Promise<void> => ipcRenderer.invoke("link:cancelPairing"),
    revoke: (id: string): Promise<void> => ipcRenderer.invoke("link:revoke", id),
    remove: (id: string): Promise<void> => ipcRenderer.invoke("link:remove", id),
    onChanged: (cb: (s: LinkSnapshot) => void) => {
      const h = (_: unknown, s: LinkSnapshot) => cb(s);
      ipcRenderer.on("link:changed", h);
      return () => ipcRenderer.removeListener("link:changed", h);
    },
  },
});
