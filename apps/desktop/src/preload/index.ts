import { contextBridge, ipcRenderer } from "electron";
import type { LinkSnapshot } from "../main/link/service";

// Narrow, typed surface. Add methods here deliberately; never expose ipcRenderer itself.
contextBridge.exposeInMainWorld("solo", {
  version: (): Promise<string> => ipcRenderer.invoke("solo:version"),
  voice: {
    setMicAllowed: (on: boolean): Promise<void> => ipcRenderer.invoke("voice:setMicAllowed", on),
    warmup: (): Promise<{ ok: true } | { ok: false; error: string }> => ipcRenderer.invoke("voice:warmup"),
    transcribe: (pcm: Float32Array): Promise<string> => ipcRenderer.invoke("voice:transcribe", pcm),
    onModelProgress: (cb: (pct: number) => void) => {
      const h = (_: unknown, p: number) => cb(p);
      ipcRenderer.on("voice:modelProgress", h);
      return () => ipcRenderer.removeListener("voice:modelProgress", h);
    },
  },
  link: {
    snapshot: (): Promise<LinkSnapshot> => ipcRenderer.invoke("link:snapshot"),
    startPairing: (): Promise<LinkSnapshot> => ipcRenderer.invoke("link:startPairing"),
    cancelPairing: (): Promise<void> => ipcRenderer.invoke("link:cancelPairing"),
    approve: (id: string): Promise<void> => ipcRenderer.invoke("link:approve", id),
    deny: (id: string): Promise<void> => ipcRenderer.invoke("link:deny", id),
    setAutoApprove: (on: boolean): Promise<void> => ipcRenderer.invoke("link:setAutoApprove", on),
    renameDevice: (id: string, name: string): Promise<void> => ipcRenderer.invoke("link:renameDevice", id, name),
    renameSelf: (name: string): Promise<void> => ipcRenderer.invoke("link:renameSelf", name),
    revoke: (id: string): Promise<void> => ipcRenderer.invoke("link:revoke", id),
    remove: (id: string): Promise<void> => ipcRenderer.invoke("link:remove", id),
    onChanged: (cb: (s: LinkSnapshot) => void) => {
      const h = (_: unknown, s: LinkSnapshot) => cb(s);
      ipcRenderer.on("link:changed", h);
      return () => ipcRenderer.removeListener("link:changed", h);
    },
  },
});
