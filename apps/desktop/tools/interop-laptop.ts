/**
 * Test helper for the Android interop test (apps/android/test/relay_interop_test.dart): a real desktop RelayClient that
 * hosts a pairing, prints the code, and echoes task.update messages back. Not part of the app.
 *
 *   npx tsx tools/interop-laptop.ts ws://127.0.0.1:PORT
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateIdentity } from "@solo/crypto";
import { DeviceStore } from "../src/main/link/store";
import { RelayClient } from "../src/main/relay/relayClient";
import { Inbox } from "../src/main/files/inbox";

const url = process.argv[2]!;
const identity = generateIdentity();
const store = new DeviceStore(join(mkdtempSync(join(tmpdir(), "solo-interop-")), "devices.json"));
const client = new RelayClient({
  identity, store,
  self: () => ({ deviceId: identity.id, kind: "windows", name: "Interop laptop", appVersion: "0.1.0", pub: identity.pub }),
});
const say = (o: object) => console.log(JSON.stringify(o));
// Received files go to argv[3] (the test reads them back from disk to prove the bytes are identical).
const inboxDir = process.argv[3] ?? join(mkdtempSync(join(tmpdir(), "solo-interop-in-")), "Solo");
const inbox = new Inbox({
  dir: inboxDir, indexFile: join(mkdtempSync(join(tmpdir(), "solo-interop-idx-")), "received.json"),
  send: (to, type, payload) => client.send(to, type, payload), deviceName: () => "Test phone", onChange: () => {},
});

client.on("status", (s) => {
  if (s === "online") say({ event: "pairing", ...client.hostPairing(), id: identity.id });
});
client.on("paired", (d) => say({ event: "paired", name: d.name, id: d.deviceId }));
client.on("connected", (d) => say({ event: "connected", name: d.name }));
client.on("message", (from, env) => {
  if (inbox.handle(from, env)) {
    if (env.type === "file.end") say({ event: "received", files: inbox.received().map((f) => ({ name: f.name, size: f.size, path: f.path })) });
    return;
  }
  say({ event: "message", type: env.type, payload: env.payload });
  if (env.type === "task.update") client.send(from, "task.update", { echo: (env.payload as { note?: string }).note, from: "laptop" });
  if (env.type === "sync.delta") client.send(from, "heartbeat", {});
});
client.setUrl(url);
setTimeout(() => process.exit(0), 90_000).unref();
