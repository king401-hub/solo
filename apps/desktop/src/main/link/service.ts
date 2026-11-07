import { app } from "electron";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { join } from "node:path";
import { Bonjour } from "bonjour-service";
import type { DeviceInfo } from "@solo/shared";
import { loadOrCreateCert } from "./cert";
import { LinkServer } from "./server";
import { DeviceStore } from "./store";

export const LINK_PORT = 47821; // fixed so the phone can reconnect without rediscovery; falls back to random if taken

export function lanAddresses(): string[] {
  return Object.values(networkInterfaces()).flat()
    .filter((i): i is NonNullable<typeof i> => !!i && i.family === "IPv4" && !i.internal).map((i) => i.address);
}

function loadIdentity(dir: string): DeviceInfo {
  const f = join(dir, "identity.json");
  if (existsSync(f)) try { return JSON.parse(readFileSync(f, "utf8")); } catch { /* recreate */ }
  const id: DeviceInfo = { deviceId: randomUUID(), kind: "windows", name: hostname(), appVersion: app.getVersion() };
  mkdirSync(dir, { recursive: true });
  writeFileSync(f, JSON.stringify(id));
  return id;
}

export interface LinkSnapshot {
  port: number; addresses: string[]; certSha256: string;
  devices: { deviceId: string; name: string; kind: string; pairedAt: number; lastSeen?: number; revoked: boolean; online: boolean }[];
  pairing?: { code: string; expiresAt: number };
}

export async function startLink(onChange: () => void) {
  const dir = app.getPath("userData");
  const self = loadIdentity(dir);
  const cert = await loadOrCreateCert(join(dir, "link-cert.json"));
  const store = new DeviceStore(join(dir, "devices.json"));
  const server = new LinkServer({ self, cert, store });
  let port: number;
  try { port = await server.listen(LINK_PORT); } catch { port = await server.listen(0); }

  const bonjour = new Bonjour();
  bonjour.publish({ name: `Solo ${self.name}`, type: "solo", port, txt: { id: self.deviceId, fp: cert.sha256 } });

  let pairing: LinkSnapshot["pairing"];
  for (const ev of ["connected", "disconnected", "paired"] as const) server.on(ev, () => { if (ev === "paired") pairing = undefined; onChange(); });

  const snapshot = (): LinkSnapshot => ({
    port, addresses: lanAddresses(), certSha256: cert.sha256,
    pairing: pairing && pairing.expiresAt > Date.now() ? pairing : undefined,
    devices: store.list().map((d) => ({
      deviceId: d.device.deviceId, name: d.device.name, kind: d.device.kind, pairedAt: d.pairedAt,
      lastSeen: d.lastSeen, revoked: !!d.revoked, online: server.onlineDeviceIds.includes(d.device.deviceId),
    })), // token deliberately omitted
  });

  return {
    snapshot, server,
    startPairing: () => { pairing = server.startPairing(); onChange(); return snapshot(); },
    cancelPairing: () => { server.cancelPairing(); pairing = undefined; onChange(); },
    revoke: (id: string) => { store.revoke(id); server.disconnect(id); onChange(); },
    remove: (id: string) => { server.disconnect(id); store.remove(id); onChange(); },
    stop: async () => { bonjour.unpublishAll(() => bonjour.destroy()); await server.close(); },
  };
}
