/**
 * Manual/live test helper: a stand-in phone that joins a pairing code shown by the running desktop app, sets a shared
 * setting, and prints what it sees. Used to exercise the real app over the relay.
 *
 *   npx tsx tools/live-phone.ts ws://127.0.0.1:PORT XXXX-XXXX-XXXX
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateIdentity } from "@solo/crypto";
import { SyncStore, type SyncDelta } from "@solo/shared";
import { DeviceStore } from "../src/main/link/store";
import { RelayClient } from "../src/main/relay/relayClient";

const [url, code] = [process.argv[2]!, process.argv[3]!];
const identity = generateIdentity();
const store = new DeviceStore(join(mkdtempSync(join(tmpdir(), "solo-livephone-")), "devices.json"));
const client = new RelayClient({
  identity, store,
  self: () => ({ deviceId: identity.id, kind: "android", name: "Live test phone", appVersion: "0.1.0", pub: identity.pub }),
});
const sync = new SyncStore(identity.id);
const say = (o: object) => console.log(JSON.stringify(o));

client.on("connected", (d) => {
  say({ event: "connected", name: d.name });
  for (const delta of sync.all()) client.send(d.deviceId, "sync.delta", delta);
});
client.on("message", (from, env) => {
  if (env.type === "sync.delta") { sync.apply(env.payload as SyncDelta); say({ event: "delta", row: (env.payload as SyncDelta).rowId, data: (env.payload as SyncDelta).data }); }
});
client.on("status", async (s) => {
  if (s !== "online" || store.list().length) return;
  const r = await client.joinPairing(code);
  say({ event: "join", result: r.ok ? "ok" : r.error });
  if (r.ok) {
    // change a shared setting from the "phone"; the desktop app must pick it up
    const d = sync.set("settings", "voice", { speechRate: 1.7, voiceGender: "female" });
    for (const id of client.onlineDeviceIds) client.send(id, "sync.delta", d);
    setTimeout(() => { const t = sync.set("settings", "voice", { speechRate: 1.7, voiceGender: "female" }); for (const id of client.onlineDeviceIds) client.send(id, "sync.delta", t); }, 1500);
  }
});
client.setUrl(url);
setTimeout(() => process.exit(0), 60_000).unref();
