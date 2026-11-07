import type { LinkSnapshot } from "../main/link/service";
declare global {
  interface Window {
    solo: {
      version(): Promise<string>;
      link: {
        snapshot(): Promise<LinkSnapshot>; startPairing(): Promise<LinkSnapshot>; cancelPairing(): Promise<void>;
        revoke(id: string): Promise<void>; remove(id: string): Promise<void>;
        onChanged(cb: (s: LinkSnapshot) => void): () => void;
      };
    };
  }
}
export {};
