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
  voiceId: {
    status: (): Promise<{ enrolled: boolean; createdAt?: number; pending: number; needed: number; encrypted: boolean }> => ipcRenderer.invoke("voiceId:status"),
    warmup: (): Promise<{ ok: true } | { ok: false; error: string }> => ipcRenderer.invoke("voiceId:warmup"),
    start: (): Promise<void> => ipcRenderer.invoke("voiceId:start"),
    cancel: (): Promise<void> => ipcRenderer.invoke("voiceId:cancel"),
    addClip: (pcm: Float32Array): Promise<{ ok: boolean; count: number; reason?: string }> => ipcRenderer.invoke("voiceId:addClip", pcm),
    finish: (): Promise<{ ok: boolean; quality: { ok: boolean; clips: number; minAgreement: number; meanAgreement: number; reason?: string } }> => ipcRenderer.invoke("voiceId:finish"),
    verify: (pcm: Float32Array, strictness: number): Promise<{ enrolled: false } | { enrolled: true; tooShort: true } | { enrolled: true; tooShort?: false; score: number; owner: boolean }> => ipcRenderer.invoke("voiceId:verify", pcm, strictness),
    reset: (): Promise<void> => ipcRenderer.invoke("voiceId:reset"),
  },
  voice: {
    setMicAllowed: (on: boolean): Promise<void> => ipcRenderer.invoke("voice:setMicAllowed", on),
    warmup: (preset?: string): Promise<{ ok: true } | { ok: false; error: string }> => ipcRenderer.invoke("voice:warmup", preset),
    transcribe: (pcm: Float32Array): Promise<string> => ipcRenderer.invoke("voice:transcribe", pcm),
    onModelProgress: (cb: (pct: number) => void) => {
      const h = (_: unknown, p: number) => cb(p);
      ipcRenderer.on("voice:modelProgress", h);
      return () => ipcRenderer.removeListener("voice:modelProgress", h);
    },
  },
  files: {
    state: () => ipcRenderer.invoke("files:state"),
    setEnabled: (on: boolean): Promise<void> => ipcRenderer.invoke("files:setEnabled", on),
    setPrivacy: (p: { globalDiscovery: boolean; relays: boolean; nat: boolean; localDiscovery: boolean }): Promise<void> => ipcRenderer.invoke("files:setPrivacy", p),
    choose: (): Promise<string | undefined> => ipcRenderer.invoke("files:choose"),
    addFolder: (i: unknown): Promise<string> => ipcRenderer.invoke("files:addFolder", i),
    accept: (folderId: string, path: string): Promise<void> => ipcRenderer.invoke("files:accept", folderId, path),
    share: (folderId: string, soloId: string): Promise<void> => ipcRenderer.invoke("files:share", folderId, soloId),
    remove: (folderId: string): Promise<void> => ipcRenderer.invoke("files:remove", folderId),
    pause: (folderId: string, paused: boolean): Promise<void> => ipcRenderer.invoke("files:pause", folderId, paused),
    rescan: (folderId: string): Promise<void> => ipcRenderer.invoke("files:rescan", folderId),
    getIgnores: (folderId: string): Promise<string[]> => ipcRenderer.invoke("files:getIgnores", folderId),
    setIgnores: (folderId: string, lines: string[]): Promise<void> => ipcRenderer.invoke("files:setIgnores", folderId, lines),
    errors: (folderId: string): Promise<{ path: string; error: string }[]> => ipcRenderer.invoke("files:errors", folderId),
    conflicts: (folderId: string) => ipcRenderer.invoke("files:conflicts", folderId),
    resolve: (folderId: string, rel: string, action: string): Promise<void> => ipcRenderer.invoke("files:resolve", folderId, rel, action),
    versions: (folderId: string, rel?: string) => ipcRenderer.invoke("files:versions", folderId, rel),
    restore: (folderId: string, versionRel: string): Promise<string> => ipcRenderer.invoke("files:restore", folderId, versionRel),
    open: (folderId: string): Promise<void> => ipcRenderer.invoke("files:open", folderId),
    reveal: (folderId: string, rel: string): Promise<void> => ipcRenderer.invoke("files:reveal", folderId, rel),
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
