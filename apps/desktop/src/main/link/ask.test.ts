import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { PROTOCOL_VERSION, type DeviceInfo } from "@solo/shared";
import { loadOrCreateCert, type LinkCert } from "./cert";
import { LinkServer } from "./server";
import { DeviceStore } from "./store";
import { authProof, isPrivateAddress, sas } from "./pairing";

const self: DeviceInfo = { deviceId: "desktop-0001", kind: "windows", name: "PC", appVersion: "0.1.0" };
const phone: DeviceInfo = { deviceId: "phone-00001", kind: "android", name: "Pixel", appVersion: "0.1.0" };
let cert: LinkCert;
beforeAll(async () => { cert = await loadOrCreateCert(join(mkdtempSync(join(tmpdir(), "solo-")), "cert.json")); });
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of cleanup.splice(0)) await c(); });

async function setup() {
  const store = new DeviceStore(join(mkdtempSync(join(tmpdir(), "solo-")), "devices.json"));
  const server = new LinkServer({ self: { ...self }, cert, store });
  const port = await server.listen(0, "127.0.0.1");
  cleanup.push(() => server.close());
  return { store, server, port };
}

function connect(port: number, device = phone) {
  const ws = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
  cleanup.push(() => ws.terminate());
  const inbox: any[] = [];
  const waiters: ((m: any) => void)[] = [];
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); const w = waiters.shift(); w ? w(m) : inbox.push(m); });
  const next = () => new Promise<any>((res) => { const m = inbox.shift(); m ? res(m) : waiters.push(res); });
  const send = (type: string, payload: unknown) =>
    ws.send(JSON.stringify({ v: PROTOCOL_VERSION, id: Math.random().toString(36), ts: Date.now(), from: device.deviceId, type, payload }));
  const open = new Promise<void>((res) => ws.on("open", () => res()));
  return { ws, next, send, open };
}
const until = async (f: () => boolean) => { for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 20)); };

describe("helpers", () => {
  it("isPrivateAddress", () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "192.168.0.9", "172.16.0.1", "172.31.255.1", "::ffff:192.168.1.5", "::1", "169.254.1.1"]) expect(isPrivateAddress(a)).toBe(true);
    for (const a of ["8.8.8.8", "172.32.0.1", "172.15.0.1", "100.64.0.1", "2001:db8::1", "", undefined]) expect(isPrivateAddress(a as string)).toBe(false);
  });
  it("sas is 4 digits, deterministic and cert-bound", () => {
    expect(sas("n", "c")).toMatch(/^\d{4}$/);
    expect(sas("n", "c")).toBe(sas("n", "c"));
    expect(sas("n", "c")).not.toBe(sas("n", "d")); // 1/10000 chance of false failure is acceptable for fixed inputs
  });
});

describe("pair.ask (code-free pairing)", () => {
  it("waits for desktop approval, then pairs", async () => {
    const { server, store, port } = await setup();
    const c = connect(port); await c.open;
    const ch = await c.next();
    c.send("pair.ask", { device: phone });
    await until(() => server.pendingRequests.length === 1);
    const req = server.pendingRequests[0]!;
    expect(req.device.name).toBe("Pixel");
    expect(req.sas).toBe(sas(ch.payload.nonce, server.certSha256)); // phone computes the same from what it saw
    expect(store.list()).toHaveLength(0); // nothing stored before approval
    server.approve(req.id);
    const acc = await c.next();
    expect(acc.type).toBe("pair.accept");
    expect(store.get(phone.deviceId)?.token).toBe(acc.payload.authToken);
    expect(server.pendingRequests).toHaveLength(0);
    expect(server.onlineDeviceIds).toEqual([phone.deviceId]);
  });

  it("deny rejects and stores nothing", async () => {
    const { server, store, port } = await setup();
    const c = connect(port); await c.open; await c.next();
    c.send("pair.ask", { device: phone });
    await until(() => server.pendingRequests.length === 1);
    server.deny(server.pendingRequests[0]!.id);
    expect((await c.next()).payload.reason).toBe("denied");
    expect(store.list()).toHaveLength(0);
  });

  it("auto-approve pairs immediately", async () => {
    const { server, store, port } = await setup();
    server.autoApprove = true;
    const c = connect(port); await c.open; await c.next();
    c.send("pair.ask", { device: phone });
    expect((await c.next()).type).toBe("pair.accept");
    expect(store.list()).toHaveLength(1);
  });

  it("drops the pending request if the client disconnects", async () => {
    const { server, port } = await setup();
    const c = connect(port); await c.open; await c.next();
    c.send("pair.ask", { device: phone });
    await until(() => server.pendingRequests.length === 1);
    c.ws.close();
    await until(() => server.pendingRequests.length === 0);
    expect(server.pendingRequests).toHaveLength(0);
  });

  it("limits pending requests (no spam) and one per device", async () => {
    const { server, port } = await setup();
    const mk = async (i: number) => {
      const d = { ...phone, deviceId: `phone-0000${i}` };
      const c = connect(port, d); await c.open; await c.next(); c.send("pair.ask", { device: d }); return c;
    };
    for (let i = 1; i <= 3; i++) await mk(i);
    await until(() => server.pendingRequests.length === 3);
    const c4 = await mk(4);
    expect((await c4.next()).payload.reason).toBe("busy");
    const dup = connect(port, { ...phone, deviceId: "phone-00001" }); await dup.open; await dup.next();
    dup.send("pair.ask", { device: { ...phone, deviceId: "phone-00001" } });
    expect((await dup.next()).payload.reason).toBe("busy");
  });
});

describe("renaming", () => {
  it("device.rename updates the stored name; alias wins over reported name", async () => {
    const { server, store, port } = await setup();
    store.add(phone, "t".repeat(64));
    const c = connect(port); await c.open;
    const ch = await c.next();
    c.send("auth.hello", { device: phone, proof: authProof("t".repeat(64), ch.payload.nonce, phone.deviceId) });
    await c.next();
    c.send("device.rename", { name: "Sol's phone" });
    await until(() => store.get(phone.deviceId)?.device.name === "Sol's phone");
    expect(store.get(phone.deviceId)?.device.name).toBe("Sol's phone");
    store.setAlias(phone.deviceId, "My Pixel");
    expect(store.get(phone.deviceId)?.alias).toBe("My Pixel");
    expect(store.get(phone.deviceId)?.device.name).toBe("Sol's phone");
    void server;
  });

  it("name sent at reconnect is picked up", async () => {
    const { store, port } = await setup();
    store.add(phone, "t".repeat(64));
    const renamed = { ...phone, name: "Renamed" };
    const c = connect(port); await c.open;
    const ch = await c.next();
    c.send("auth.hello", { device: renamed, proof: authProof("t".repeat(64), ch.payload.nonce, phone.deviceId) });
    await c.next();
    expect(store.get(phone.deviceId)?.device.name).toBe("Renamed");
  });

  it("desktop name change shows up in the next challenge", async () => {
    const { server, port } = await setup();
    server.setSelfName("Studio PC");
    const c = connect(port); await c.open;
    expect((await c.next()).payload.device.name).toBe("Studio PC");
  });
});
