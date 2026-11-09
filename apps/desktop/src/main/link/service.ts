import { app, Notification, shell } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { join } from "node:path";
import { Bonjour } from "bonjour-service";
import type { DeviceInfo } from "@solo/shared";
import { loadOrCreateCert } from "./cert";
import { LinkServer } from "./server";
import { DeviceStore } from "./store";
import { generateIdentity, identityFromSeed, selfTest, type Identity } from "@solo/crypto";
import { createSync } from "../sync/sync";
import { Hub } from "./hub";
import { createFiles } from "../files/service";
import { Inbox } from "../files/inbox";
import { Outbox } from "../files/outbox";
import { RelayClient, validRelayUrl } from "../relay/relayClient";
import type { SyncDelta } from "@solo/shared";

export const LINK_PORT = 47821; // fixed so the phone can reconnect without rediscovery; falls back to random if taken

export function lanAddresses(): string[] {
  return Object.values(networkInterfaces()).flat()
    .filter((i): i is NonNullable<typeof i> => !!i && i.family === "IPv4" && !i.internal).map((i) => i.address);
}

/** Device identity: an Ed25519 key (kept in userData, mode 0600). deviceId = SHA-256(public key). */
function loadKeys(dir: string): Identity {
  const f = join(dir, "identity-key.json");
  if (existsSync(f)) try { return identityFromSeed(JSON.parse(readFileSync(f, "utf8")).seed); } catch { /* regenerate */ }
  const id = generateIdentity();
  mkdirSync(dir, { recursive: true });
  writeFileSync(f, JSON.stringify({ seed: id.seed }), { mode: 0o600 });
  return id;
}

function loadName(dir: string): string {
  try { const n = JSON.parse(readFileSync(join(dir, "identity.json"), "utf8")).name; if (typeof n === "string" && n) return n; } catch { /* default */ }
  return hostname();
}

export interface LinkSnapshot {
  port: number; addresses: string[]; certSha256: string; selfName: string; autoApprove: boolean;
  requests: { id: string; name: string; kind: string; sas: string; expiresAt: number }[];
  devices: { deviceId: string; name: string; kind: string; pairedAt: number; lastSeen?: number; revoked: boolean; online: boolean; via?: "lan" | "relay" }[];
  pairing?: { code: string; expiresAt: number };
  /** Internet access through the Solo relay. */
  relay: { url?: string; status: "off" | "connecting" | "online"; pairing?: { code: string; expiresAt: number }; error?: string };
}

export async function startLink(onChange: () => void, onSync: (d: SyncDelta, local: boolean) => void = () => {}) {
  const dir = app.getPath("userData");
  const keys = loadKeys(dir);
  const self: DeviceInfo = { deviceId: keys.id, kind: "windows", name: loadName(dir), appVersion: app.getVersion(), pub: keys.pub };
  const settingsFile = join(dir, "link-settings.json");
  const saved: { autoApprove?: boolean } = existsSync(settingsFile) ? (() => { try { return JSON.parse(readFileSync(settingsFile, "utf8")); } catch { return {}; } })() : {};
  const saveSettings = () => writeFileSync(settingsFile, JSON.stringify({ autoApprove: server.autoApprove }));
  const cert = await loadOrCreateCert(join(dir, "link-cert.json"));
  const store = new DeviceStore(join(dir, "devices.json"));
  const server = new LinkServer({ self, cert, store });
  server.autoApprove = !!saved.autoApprove;
  const relay = new RelayClient({ identity: keys, self: () => self, store });
  // Electron's crypto differs from plain Node; prove every primitive works here before offering remote access.
  const cryptoError = selfTest();
  if (cryptoError) console.error("[solo] remote access disabled, crypto self-test failed:", cryptoError);
  const hub = new Hub(server, relay);
  const sync = createSync({
    file: join(dir, "sync.json"), deviceId: self.deviceId, server: hub,
    onChange: (d, local) => {
      // The relay address is shared by every device, so configuring it once configures them all.
      if (d.table === "settings" && d.rowId === "relay" && !cryptoError) relay.setUrl(typeof d.data?.["url"] === "string" ? (d.data["url"] as string) : undefined);
      onSync(d, local);
    },
  });
  if (!cryptoError) relay.setUrl(typeof sync.store.get("settings", "relay")?.["url"] === "string" ? (sync.store.get("settings", "relay")!["url"] as string) : undefined);
  let port: number;
  try { port = await server.listen(LINK_PORT); } catch { port = await server.listen(0); }

  // File sync (Syncthing engine) is opt-in; it only starts when the user has turned it on.
  const syncthingBin = app.isPackaged ? join(process.resourcesPath, "syncthing", "syncthing.exe") : join(app.getAppPath(), "resources", "syncthing", "syncthing.exe");
  const files = createFiles({
    dir, binary: syncthingBin, hub, store, selfName: () => self.name, onChange: () => onChange(),
    trash: (p) => shell.trashItem(p), // replaced files go to the Recycle Bin, never straight to oblivion
  });
  void files.start();

  // Files sent from the phone land in Downloads\Solo. Nothing is opened or run, and nothing replaces an existing file.
  const nameOf = (id: string) => { const d = store.list().find((x) => x.device.deviceId === id); return d ? (d.alias ?? d.device.name) : "A device"; };
  const inbox = new Inbox({
    dir: join(app.getPath("downloads"), "Solo"), indexFile: join(dir, "received-files.json"),
    send: (to, type, payload) => hub.send(to, type, payload), deviceName: nameOf, onChange: () => onChange(),
  });
  const outbox = new Outbox({ send: (to, type, payload) => hub.send(to, type, payload), deviceName: nameOf, onChange: () => onChange() });
  hub.on("disconnected", (id) => outbox.peerLost(id));
  hub.on("message", (from, env) => {
    if (outbox.handle(from, env)) return; // replies, acks and results for files we are sending
    const before = inbox.received().length;
    if (!inbox.handle(from, env)) return;
    if (env.type === "file.end" && inbox.received().length > before && Notification.isSupported()) {
      const f = inbox.received()[0];
      if (f) new Notification({ title: "Solo received a file", body: `${f.name} from ${f.fromName}` }).show();
    }
  });

  const bonjour = new Bonjour();
  bonjour.publish({ name: `Solo ${self.name}`, type: "solo", port, txt: { id: self.deviceId, fp: cert.sha256 } });

  let pairing: LinkSnapshot["pairing"];
  for (const ev of ["pairRequestsChanged", "devicesChanged"] as const) server.on(ev, () => onChange());
  for (const ev of ["connected", "disconnected", "paired"] as const) server.on(ev, () => { if (ev === "paired") pairing = undefined; onChange(); });
  for (const ev of ["connected", "disconnected", "paired", "status"] as const) relay.on(ev, () => onChange());
  server.on("paired", () => relay.refreshWatch());

  const snapshot = (): LinkSnapshot => ({
    port, addresses: lanAddresses(), certSha256: cert.sha256, selfName: self.name, autoApprove: server.autoApprove,
    requests: server.pendingRequests.map((r) => ({ id: r.id, name: r.device.name, kind: r.device.kind, sas: r.sas, expiresAt: r.expiresAt })),
    pairing: pairing && pairing.expiresAt > Date.now() ? pairing : undefined,
    devices: store.list().map((d) => ({
      deviceId: d.device.deviceId, name: d.alias ?? d.device.name, kind: d.device.kind, pairedAt: d.pairedAt,
      lastSeen: d.lastSeen, revoked: !!d.revoked, online: hub.onlineDeviceIds.includes(d.device.deviceId),
      via: hub.isOnLan(d.device.deviceId) ? "lan" as const : hub.isOnRelay(d.device.deviceId) ? "relay" as const : undefined,
    })), // token deliberately omitted
    relay: { url: relay.relayUrl, status: relay.status, pairing: relay.pairing, error: cryptoError ? `Remote access is unavailable on this PC (${cryptoError}).` : undefined },
  });

  return {
    snapshot, server, sync: sync.store, hub, files, inbox, outbox,
    startPairing: () => { pairing = server.startPairing(); onChange(); return snapshot(); },
    cancelPairing: () => { server.cancelPairing(); pairing = undefined; onChange(); },
    approve: (id: string) => server.approve(id),
    deny: (id: string) => server.deny(id),
    setAutoApprove: (on: boolean) => { server.autoApprove = on; saveSettings(); onChange(); },
    renameDevice: (id: string, name: string) => { store.setAlias(id, name); onChange(); },
    renameSelf: (name: string) => {
      const n = name.trim().slice(0, 80); if (!n) return;
      self.name = n; server.setSelfName(n);
      writeFileSync(join(dir, "identity.json"), JSON.stringify({ name: n })); onChange();
    },
    /** Returns an error message, or undefined on success. Empty string turns remote access off. */
    setRelayUrl: (url: string): string | undefined => {
      const u = url.trim().replace(/\/+$/, "");
      if (u && !validRelayUrl(u)) return "Use a wss:// address (for example wss://your-relay.fly.dev)";
      sync.store.set("settings", "relay", { url: u }); // shared with every paired device
      onChange();
      return undefined;
    },
    relayHostPairing: () => { const r = relay.hostPairing(); onChange(); return r; },
    relayCancelPairing: () => { relay.cancelPairing(); onChange(); },
    relayJoin: (code: string) => relay.joinPairing(code),
    revoke: (id: string) => { store.revoke(id); server.disconnect(id); onChange(); },
    remove: (id: string) => { server.disconnect(id); store.remove(id); relay.refreshWatch(); onChange(); },
    stop: async () => { outbox.stop(); inbox.stop(); await files.stop(); relay.stop(); sync.flush(); bonjour.unpublishAll(() => bonjour.destroy()); await server.close(); },
  };
}
