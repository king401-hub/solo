/// <reference types="vite/client" />
import type { LinkSnapshot } from "../main/link/service";
declare global {
  interface Window {
    solo: {
      version(): Promise<string>;
      voice: {
        setMicAllowed(on: boolean): Promise<void>;
        warmup(): Promise<{ ok: true } | { ok: false; error: string }>;
        transcribe(pcm: Float32Array): Promise<string>;
        onModelProgress(cb: (pct: number) => void): () => void;
      };
      link: {
        snapshot(): Promise<LinkSnapshot>; startPairing(): Promise<LinkSnapshot>; cancelPairing(): Promise<void>;
        approve(id: string): Promise<void>; deny(id: string): Promise<void>; setAutoApprove(on: boolean): Promise<void>;
        renameDevice(id: string, name: string): Promise<void>; renameSelf(name: string): Promise<void>;
        revoke(id: string): Promise<void>; remove(id: string): Promise<void>;
        onChanged(cb: (s: LinkSnapshot) => void): () => void;
      };
    };
  }
}
export {};
