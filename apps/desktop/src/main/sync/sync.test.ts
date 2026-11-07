import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { PROTOCOL_VERSION, type DeviceInfo } from "@solo/shared";
import { loadOrCreateCert, type LinkCert } from "../link/cert";
import { LinkServer } from "../link/server";
import { DeviceStore } from "../link/store";
import { authProof } from "../link/pairing";
import { createSync } from "./sync";

const self: DeviceInfo = { deviceId: "desktop-0001", kind: "windows", name: "PC", appVersion: "0.1.0" };
const phoneA: DeviceInfo = { deviceId: "phone-0000A", kind: "android", name: "A", appVersion: "0.1.0" };
const phoneB: DeviceInfo = { deviceId: "phone-0000B", kind: "android", name: "B", appVersion: "0.1.0" };
const TOKEN = "t".repeat(64);
let cert: LinkCert;
beforeAll(async () => { cert = await loadOrCreateCert(join(mkdtempSync(join(tmpdir(), "solo-")), "cert.json")); });
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of cleanup.splice(0)) await c(); });

async function setup(file = join(mkdtempSync(join(tmpdir(), "solo-")), "sync.json")) {
  const store = new DeviceStore(join(mkdtempSync(join(tmpdir(), "solo-")), "devices.json"));
  store.add(phoneA, TOKEN); store.add(phoneB, TOKEN);
  const server = new LinkServer({ self: { ...self }, cert, store });
  const port = await server.listen(0, "127.0.0.1");
  const events: string[] = [];
  const sync = createSync({ file, deviceId: self.deviceId, server, onChange: (d, local) => events.push(`${local ? "L" : "R"}:${d.rowId}`) });
  cleanup.push(() => server.close());
  return { server, port, sync, events, file };
}

async function client(port: number, device: DeviceInfo) {
  const ws = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
  cleanup.push(() => ws.terminate());
  const deltas: any[] = [];
  let resolveAuth!: () => void;
  const authed = new Promise<void>((r) => (resolveAuth = r));
  const send = (type: string, payload: unknown) =>
    ws.send(JSON.stringify({ v: PROTOCOL_VERSION, id: Math.random().toString(36), ts: Date.now(), from: device.deviceId, type, payload }));
  ws.on("message", (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === "auth.challenge") send("auth.hello", { device, proof: authProof(TOKEN, m.payload.nonce, device.deviceId) });
    else if (m.type === "auth.ok") resolveAuth();
    else if (m.type === "sync.delta") deltas.push(m.payload);
  });
  await authed;
  return { send, deltas, ws };
}
const until = async (f: () => boolean) => { for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 20)); };

describe("desktop sync", () => {
  it("sends its whole state to a device when it connects", async () => {
    const { port, sync } = await setup();
    sync.store.set("settings", "voice", { speechRate: 1.3 });
    const c = await client(port, phoneA);
    await until(() => c.deltas.length === 1);
    expect(c.deltas[0]).toMatchObject({ table: "settings", rowId: "voice", data: { speechRate: 1.3 }, by: self.deviceId });
  });

  it("applies a phone edit, notifies the UI, and relays it to the other phone but not back", async () => {
    const { port, sync, events } = await setup();
    const a = await client(port, phoneA);
    const b = await client(port, phoneB);
    a.send("sync.delta", { table: "settings", rowId: "voice", updatedAt: Date.now() + 5, by: phoneA.deviceId, deleted: false, data: { speechRate: 0.7 } });
    await until(() => b.deltas.some((d) => d.rowId === "voice"));
    expect(sync.store.get("settings", "voice")).toEqual({ speechRate: 0.7 });
    expect(events).toContain("R:voice");
    expect(b.deltas.at(-1).data).toEqual({ speechRate: 0.7 });
    await new Promise((r) => setTimeout(r, 100));
    expect(a.deltas.filter((d) => d.rowId === "voice")).toHaveLength(0); // origin is not echoed
  });

  it("a local PC edit is pushed live to every connected phone", async () => {
    const { port, sync } = await setup();
    const a = await client(port, phoneA);
    const b = await client(port, phoneB);
    sync.store.set("settings", "voice", { followUpSeconds: 30 });
    await until(() => a.deltas.length > 0 && b.deltas.length > 0);
    expect(a.deltas.at(-1).data).toEqual({ followUpSeconds: 30 });
    expect(b.deltas.at(-1).data).toEqual({ followUpSeconds: 30 });
  });

  it("stale phone data does not overwrite newer PC data", async () => {
    const { port, sync } = await setup();
    sync.store.set("settings", "voice", { speechRate: 1.5 });
    const a = await client(port, phoneA);
    a.send("sync.delta", { table: "settings", rowId: "voice", updatedAt: 1, by: phoneA.deviceId, deleted: false, data: { speechRate: 0.5 } });
    await new Promise((r) => setTimeout(r, 150));
    expect(sync.store.get("settings", "voice")).toEqual({ speechRate: 1.5 });
  });

  it("persists to disk and reloads", async () => {
    const { sync, file } = await setup();
    sync.store.set("settings", "voice", { quickWord: true });
    sync.flush();
    const again = await setup(file);
    expect(again.sync.store.get("settings", "voice")).toEqual({ quickWord: true });
  });

  it("rejects malformed deltas (schema) without changing state", async () => {
    const { port, sync } = await setup();
    const a = await client(port, phoneA);
    a.send("sync.delta", { table: "evil", rowId: "x", updatedAt: 5, by: "a", deleted: false });
    a.send("sync.delta", { table: "settings", rowId: "x", updatedAt: "now", deleted: false });
    await new Promise((r) => setTimeout(r, 150));
    expect(sync.store.all()).toHaveLength(0);
  });
});
