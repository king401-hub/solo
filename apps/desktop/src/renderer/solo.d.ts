/// <reference types="vite/client" />
import type { LinkSnapshot } from "../main/link/service";
import type { FileSyncState } from "../main/files/service";
import type { Conflict, VersionEntry } from "../main/files/conflicts";
declare global {
  interface Window {
    solo: {
      version(): Promise<string>;
      app: {
        getBackground(): Promise<{ runInBackground: boolean; startWithWindows: boolean; autoListen: boolean; visible: boolean }>;
        setBackground(patch: { runInBackground?: boolean; startWithWindows?: boolean; autoListen?: boolean }): Promise<{ runInBackground: boolean; startWithWindows: boolean; autoListen: boolean }>;
        reveal(): Promise<void>;
        quit(): Promise<void>;
      };
      voiceId: {
        status(): Promise<{ enrolled: boolean; createdAt?: number; pending: number; needed: number; encrypted: boolean }>;
        warmup(): Promise<{ ok: true } | { ok: false; error: string }>;
        start(): Promise<void>;
        cancel(): Promise<void>;
        addClip(pcm: Float32Array): Promise<{ ok: boolean; count: number; reason?: string }>;
        finish(): Promise<{ ok: boolean; quality: { ok: boolean; clips: number; minAgreement: number; meanAgreement: number; reason?: string } }>;
        verify(pcm: Float32Array, strictness: number): Promise<{ enrolled: false } | { enrolled: true; tooShort: true } | { enrolled: true; tooShort?: false; score: number; owner: boolean }>;
        reset(): Promise<void>;
      };
      voice: {
        setMicAllowed(on: boolean): Promise<void>;
        warmup(preset?: string): Promise<{ ok: true } | { ok: false; error: string }>;
        transcribe(pcm: Float32Array): Promise<string>;
        onModelProgress(cb: (pct: number) => void): () => void;
      };
      send: {
        state(): Promise<{ devices: { deviceId: string; name: string; online: boolean; via?: "lan" | "relay" }[]; transfers: { id: string; name: string; size: number; sent: number; status: "waiting" | "sending" | "finishing" | "done" | "failed" | "cancelled"; error?: string; toName: string }[] }>;
        choose(deviceId: string): Promise<string[]>;
        paths(deviceId: string, paths: string[]): Promise<string[]>;
        cancel(id: string): Promise<void>;
        clear(): Promise<void>;
        pathFor(f: File): string;
      };
      inbox: {
        state(): Promise<{ folder: string; received: { id: string; name: string; fromName: string; size: number; at: number }[]; receiving: { transferId: string; name: string; fromName: string; size: number; received: number }[] }>;
        openFolder(): Promise<void>;
        reveal(id: string): Promise<void>;
        open(id: string): Promise<void>;
        forget(id: string): Promise<void>;
      };
      files: {
        state(): Promise<FileSyncState>;
        setEnabled(on: boolean): Promise<void>;
        setPrivacy(p: { globalDiscovery: boolean; relays: boolean; nat: boolean; localDiscovery: boolean }): Promise<void>;
        choose(): Promise<string | undefined>;
        addFolder(i: { path: string; label: string; deviceSoloIds: string[]; ignore?: Record<string, boolean>; keepDays?: number }): Promise<string>;
        accept(folderId: string, path: string): Promise<void>;
        share(folderId: string, soloId: string): Promise<void>;
        remove(folderId: string): Promise<void>;
        pause(folderId: string, paused: boolean): Promise<void>;
        rescan(folderId: string): Promise<void>;
        getIgnores(folderId: string): Promise<string[]>;
        setIgnores(folderId: string, lines: string[]): Promise<void>;
        errors(folderId: string): Promise<{ path: string; error: string }[]>;
        conflicts(folderId: string): Promise<Conflict[]>;
        resolve(folderId: string, rel: string, action: "keep-current" | "use-conflict" | "keep-both"): Promise<void>;
        versions(folderId: string, rel?: string): Promise<VersionEntry[]>;
        restore(folderId: string, versionRel: string): Promise<string>;
        open(folderId: string): Promise<void>;
        reveal(folderId: string, rel: string): Promise<void>;
      };
      sync: {
        get(table: string, id: string): Promise<Record<string, unknown> | undefined>;
        set(table: string, id: string, data: Record<string, unknown>): Promise<void>;
        onChanged(cb: (c: { table: string; rowId: string; data?: Record<string, unknown> }) => void): () => void;
      };
      link: {
        snapshot(): Promise<LinkSnapshot>; startPairing(): Promise<LinkSnapshot>; cancelPairing(): Promise<void>;
        approve(id: string): Promise<void>; deny(id: string): Promise<void>; setAutoApprove(on: boolean): Promise<void>;
        renameDevice(id: string, name: string): Promise<void>; renameSelf(name: string): Promise<void>;
        setRelayUrl(url: string): Promise<string | undefined>;
        relayHost(): Promise<{ code: string; expiresAt: number }>;
        relayCancel(): Promise<void>;
        relayJoin(code: string): Promise<{ ok: true } | { ok: false; error: string }>;
        revoke(id: string): Promise<void>; remove(id: string): Promise<void>;
        onChanged(cb: (s: LinkSnapshot) => void): () => void;
      };
    };
  }
}
export {};
