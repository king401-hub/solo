import { contextBridge, ipcRenderer } from "electron";
import type { LinkSnapshot } from "../main/link/service";

// Narrow, typed surface. Add methods here deliberately; never expose ipcRenderer itself.
contextBridge.exposeInMainWorld("solo", {
  version: (): Promise<string> => ipcRenderer.invoke("solo:version"),
  app: {
    getBackground: (): Promise<{ runInBackground: boolean; startWithWindows: boolean; autoListen: boolean; visible: boolean }> => ipcRenderer.invoke("app:getBackground"),
    setBackground: (patch: { runInBackground?: boolean; startWithWindows?: boolean; autoListen?: boolean }): Promise<{ runInBackground: boolean; startWithWindows: boolean; autoListen: boolean }> => ipcRenderer.invoke("app:setBackground", patch),
    reveal: (): Promise<void> => ipcRenderer.invoke("app:reveal"),
    quit: (): Promise<void> => ipcRenderer.invoke("app:quit"),
  },
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
  sync: {
    get: (table: string, id: string): Promise<Record<string, unknown> | undefined> => ipcRenderer.invoke("sync:get", table, id),
    set: (table: string, id: string, data: Record<string, unknown>): Promise<void> => ipcRenderer.invoke("sync:set", table, id, data),
    onChanged: (cb: (c: { table: string; rowId: string; data?: Record<string, unknown> }) => void) => {
      const h = (_: unknown, c: { table: string; rowId: string; data?: Record<string, unknown> }) => cb(c);
      ipcRenderer.on("sync:changed", h);
      return () => ipcRenderer.removeListener("sync:changed", h);
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
    setRelayUrl: (url: string): Promise<string | undefined> => ipcRenderer.invoke("link:setRelayUrl", url),
    relayHost: (): Promise<{ code: string; expiresAt: number }> => ipcRenderer.invoke("link:relayHost"),
    relayCancel: (): Promise<void> => ipcRenderer.invoke("link:relayCancel"),
    relayJoin: (code: string): Promise<{ ok: true } | { ok: false; error: string }> => ipcRenderer.invoke("link:relayJoin", code),
    revoke: (id: string): Promise<void> => ipcRenderer.invoke("link:revoke", id),
    remove: (id: string): Promise<void> => ipcRenderer.invoke("link:remove", id),
    onChanged: (cb: (s: LinkSnapshot) => void) => {
      const h = (_: unknown, s: LinkSnapshot) => cb(s);
      ipcRenderer.on("link:changed", h);
      return () => ipcRenderer.removeListener("link:changed", h);
    },
  },
});
