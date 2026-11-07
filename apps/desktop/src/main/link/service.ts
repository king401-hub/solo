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
  port: number; addresses: string[]; certSha256: string; selfName: string; autoApprove: boolean;
  requests: { id: string; name: string; kind: string; sas: string; expiresAt: number }[];
  devices: { deviceId: string; name: string; kind: string; pairedAt: number; lastSeen?: number; revoked: boolean; online: boolean }[];
  pairing?: { code: string; expiresAt: number };
}

export async function startLink(onChange: () => void) {
  const dir = app.getPath("userData");
  const self = loadIdentity(dir);
  const settingsFile = join(dir, "link-settings.json");
  const saved: { autoApprove?: boolean } = existsSync(settingsFile) ? (() => { try { return JSON.parse(readFileSync(settingsFile, "utf8")); } catch { return {}; } })() : {};
  const saveSettings = () => writeFileSync(settingsFile, JSON.stringify({ autoApprove: server.autoApprove }));
  const cert = await loadOrCreateCert(join(dir, "link-cert.json"));
  const store = new DeviceStore(join(dir, "devices.json"));
  const server = new LinkServer({ self, cert, store });
  server.autoApprove = !!saved.autoApprove;
  let port: number;
  try { port = await server.listen(LINK_PORT); } catch { port = await server.listen(0); }

  const bonjour = new Bonjour();
  bonjour.publish({ name: `Solo ${self.name}`, type: "solo", port, txt: { id: self.deviceId, fp: cert.sha256 } });

  let pairing: LinkSnapshot["pairing"];
  for (const ev of ["pairRequestsChanged", "devicesChanged"] as const) server.on(ev, () => onChange());
  for (const ev of ["connected", "disconnected", "paired"] as const) server.on(ev, () => { if (ev === "paired") pairing = undefined; onChange(); });

  const snapshot = (): LinkSnapshot => ({
    port, addresses: lanAddresses(), certSha256: cert.sha256, selfName: self.name, autoApprove: server.autoApprove,
    requests: server.pendingRequests.map((r) => ({ id: r.id, name: r.device.name, kind: r.device.kind, sas: r.sas, expiresAt: r.expiresAt })),
    pairing: pairing && pairing.expiresAt > Date.now() ? pairing : undefined,
    devices: store.list().map((d) => ({
      deviceId: d.device.deviceId, name: d.alias ?? d.device.name, kind: d.device.kind, pairedAt: d.pairedAt,
      lastSeen: d.lastSeen, revoked: !!d.revoked, online: server.onlineDeviceIds.includes(d.device.deviceId),
    })), // token deliberately omitted
  });

  return {
    snapshot, server,
    startPairing: () => { pairing = server.startPairing(); onChange(); return snapshot(); },
    cancelPairing: () => { server.cancelPairing(); pairing = undefined; onChange(); },
    approve: (id: string) => server.approve(id),
    deny: (id: string) => server.deny(id),
    setAutoApprove: (on: boolean) => { server.autoApprove = on; saveSettings(); onChange(); },
    renameDevice: (id: string, name: string) => { store.setAlias(id, name); onChange(); },
    renameSelf: (name: string) => {
      const n = name.trim().slice(0, 80); if (!n) return;
      self.name = n; server.setSelfName(n);
      writeFileSync(join(dir, "identity.json"), JSON.stringify(self)); onChange();
    },
    revoke: (id: string) => { store.revoke(id); server.disconnect(id); onChange(); },
    remove: (id: string) => { server.disconnect(id); store.remove(id); onChange(); },
    stop: async () => { bonjour.unpublishAll(() => bonjour.destroy()); await server.close(); },
  };
}
