import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { DeviceInfo } from "@solo/shared";

export interface PairedDevice { device: DeviceInfo; token: string; pairedAt: number; lastSeen?: number; revoked?: boolean }

/** Paired devices persisted as JSON (atomic write). Tokens are secrets: never log or send to the renderer. */
export class DeviceStore {
  private devices = new Map<string, PairedDevice>();
  constructor(private file: string) {
    if (existsSync(file)) {
      try { for (const d of JSON.parse(readFileSync(file, "utf8")) as PairedDevice[]) this.devices.set(d.device.deviceId, d); }
      catch { /* corrupt store: start empty rather than crash; user re-pairs */ }
    }
  }
  private save() {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, JSON.stringify([...this.devices.values()], null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
  get(id: string) { return this.devices.get(id); }
  list() { return [...this.devices.values()]; }
  add(device: DeviceInfo, token: string) { this.devices.set(device.deviceId, { device, token, pairedAt: Date.now() }); this.save(); }
  touch(id: string) { const d = this.devices.get(id); if (d) { d.lastSeen = Date.now(); this.save(); } }
  revoke(id: string) { const d = this.devices.get(id); if (d) { d.revoked = true; this.save(); } }
  remove(id: string) { this.devices.delete(id); this.save(); }
}
