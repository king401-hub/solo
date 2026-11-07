import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { PROTOCOL_VERSION, type DeviceInfo } from "@solo/shared";
import { loadOrCreateCert, type LinkCert } from "./cert";
import { LinkServer } from "./server";
import { DeviceStore } from "./store";
import { authProof, pairProof, PairingSession } from "./pairing";

const self: DeviceInfo = { deviceId: "desktop-0001", kind: "windows", name: "PC", appVersion: "0.1.0" };
const phone: DeviceInfo = { deviceId: "phone-00001", kind: "android", name: "Pixel", appVersion: "0.1.0" };
let cert: LinkCert;
beforeAll(async () => { cert = await loadOrCreateCert(join(mkdtempSync(join(tmpdir(), "solo-")), "cert.json")); });

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of cleanup.splice(0)) await c(); });

async function setup() {
  const store = new DeviceStore(join(mkdtempSync(join(tmpdir(), "solo-")), "devices.json"));
  const server = new LinkServer({ self, cert, store });
  const port = await server.listen(0, "127.0.0.1");
  cleanup.push(() => server.close());
  return { store, server, port };
}

/** Minimal client that behaves like the phone: answers the challenge, trusts the pinned cert. */
function connect(port: number, device = phone) {
  const ws = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
  cleanup.push(() => ws.terminate());
  const inbox: any[] = [];
  const waiters: ((m: any) => void)[] = [];
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); const w = waiters.shift(); w ? w(m) : inbox.push(m); });
  const next = () => new Promise<any>((res) => { const m = inbox.shift(); m ? res(m) : waiters.push(res); });
  const closed = new Promise<number>((res) => ws.on("close", (c) => res(c)));
  const send = (type: string, payload: unknown) =>
    ws.send(JSON.stringify({ v: PROTOCOL_VERSION, id: Math.random().toString(36), ts: Date.now(), from: device.deviceId, type, payload }));
  const open = new Promise<void>((res) => ws.on("open", () => res()));
  return { ws, next, send, closed, open, device };
}

describe("pairing primitives", () => {
  it("proof is bound to code, nonce, device and cert", () => {
    const base = pairProof("123456", "n", "d", "c");
    expect(pairProof("123457", "n", "d", "c")).not.toBe(base);
    expect(pairProof("123456", "m", "d", "c")).not.toBe(base);
    expect(pairProof("123456", "n", "e", "c")).not.toBe(base);
    expect(pairProof("123456", "n", "d", "x")).not.toBe(base);
  });
  it("known vectors (shared with the Dart implementation)", () => {
    expect(pairProof("123456", "00112233445566778899aabbccddeeff", "phone-00001", "ab".repeat(32))).toBe("bb71c28157b8a9dedf480cb8cd33f8061bb64aad0a1d7c14c4d50c1d5c4a7d82");
    expect(authProof("cd".repeat(32), "00112233445566778899aabbccddeeff", "phone-00001")).toBe("916e027001e174024860983336d1c1b850e3f939968c9e9bf5c7718507d9c0fd");
  });
  it("locks after 5 bad attempts and expires", () => {
    let t = 0; const s = new PairingSession(() => t);
    for (let i = 0; i < 5; i++) expect(s.verify("bad", "n", "d", "c")).toBe("bad_proof");
    expect(s.verify(pairProof(s.code, "n", "d", "c"), "n", "d", "c")).toBe("locked");
    t = 0; const s2 = new PairingSession(() => t); t = 3 * 60_000;
    expect(s2.verify(pairProof(s2.code, "n", "d", "c"), "n", "d", "c")).toBe("expired");
  });
  it("code works once", () => {
    const s = new PairingSession();
    expect(s.verify(pairProof(s.code, "n", "d", "c"), "n", "d", "c")).toBe("ok");
    expect(s.verify(pairProof(s.code, "n", "d", "c"), "n", "d", "c")).toBe("locked");
  });
});

describe("link server", () => {
  it("pairs with the right code, then reconnects with the token", async () => {
    const { server, store, port } = await setup();
    const { code } = server.startPairing();
    const c = connect(port); await c.open;
    const ch = await c.next();
    expect(ch.type).toBe("auth.challenge");
    c.send("pair.request", { device: phone, pairingCodeProof: pairProof(code, ch.payload.nonce, phone.deviceId, server.certSha256) });
    const acc = await c.next();
    expect(acc.type).toBe("pair.accept");
    const token = acc.payload.authToken;
    expect(store.get(phone.deviceId)?.token).toBe(token);
    expect(server.onlineDeviceIds).toEqual([phone.deviceId]);
    c.ws.close(); await c.closed;

    const c2 = connect(port); await c2.open;
    const ch2 = await c2.next();
    c2.send("auth.hello", { device: phone, proof: authProof(token, ch2.payload.nonce, phone.deviceId) });
    expect((await c2.next()).type).toBe("auth.ok");
  });

  it("rejects a wrong code and does not store the device", async () => {
    const { server, store, port } = await setup();
    server.startPairing();
    const c = connect(port); await c.open;
    const ch = await c.next();
    c.send("pair.request", { device: phone, pairingCodeProof: pairProof("000000x", ch.payload.nonce, phone.deviceId, server.certSha256) });
    expect((await c.next()).payload.reason).toBe("bad_proof");
    expect(store.list()).toHaveLength(0);
  });

  it("rejects pairing when no window is open", async () => {
    const { server, port } = await setup();
    const c = connect(port); await c.open;
    const ch = await c.next();
    c.send("pair.request", { device: phone, pairingCodeProof: pairProof("123456", ch.payload.nonce, phone.deviceId, server.certSha256) });
    expect((await c.next()).payload.reason).toBe("expired");
  });

  it("MITM proof computed over a different cert fingerprint fails", async () => {
    const { server, port } = await setup();
    const { code } = server.startPairing();
    const c = connect(port); await c.open;
    const ch = await c.next();
    c.send("pair.request", { device: phone, pairingCodeProof: pairProof(code, ch.payload.nonce, phone.deviceId, "ff".repeat(32)) });
    expect((await c.next()).payload.reason).toBe("bad_proof");
  });

  it("rejects unknown and revoked devices; replayed proof fails on a new nonce", async () => {
    const { store, port } = await setup();
    const c = connect(port); await c.open;
    const ch = await c.next();
    c.send("auth.hello", { device: phone, proof: authProof("x".repeat(64), ch.payload.nonce, phone.deviceId) });
    expect((await c.next()).payload.reason).toBe("unknown_device");

    store.add(phone, "t".repeat(64));
    const oldProof = authProof("t".repeat(64), ch.payload.nonce, phone.deviceId);
    const c2 = connect(port); await c2.open; await c2.next();
    c2.send("auth.hello", { device: phone, proof: oldProof });
    expect((await c2.next()).payload.reason).toBe("bad_proof");

    store.revoke(phone.deviceId);
    const c3 = connect(port); await c3.open;
    const ch3 = await c3.next();
    c3.send("auth.hello", { device: phone, proof: authProof("t".repeat(64), ch3.payload.nonce, phone.deviceId) });
    expect((await c3.next()).payload.reason).toBe("revoked");
  });

  it("ignores everything before authentication and forwards messages after", async () => {
    const { server, store, port } = await setup();
    store.add(phone, "t".repeat(64));
    const got: any[] = [];
    server.on("message", (_id, env) => got.push(env));
    const c = connect(port); await c.open;
    const ch = await c.next();
    c.send("sync.delta", { table: "tasks", rowId: "1", updatedAt: 1, by: phone.deviceId, deleted: false }); // pre-auth: dropped
    c.send("auth.hello", { device: phone, proof: authProof("t".repeat(64), ch.payload.nonce, phone.deviceId) });
    await c.next();
    c.send("sync.delta", { table: "tasks", rowId: "2", updatedAt: 2, by: phone.deviceId, deleted: false });
    await new Promise((r) => setTimeout(r, 100));
    expect(got.map((e) => e.payload.rowId)).toEqual(["2"]);
  });

  it("serves a stable, pinnable certificate", async () => {
    const { port, server } = await setup();
    const fp = await new Promise<string>((res) => {
      const ws = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
      ws.on("upgrade", (r) => res((r.socket as any).getPeerCertificate().fingerprint256.replace(/:/g, "").toLowerCase()));
      cleanup.push(() => ws.terminate());
    });
    expect(fp).toBe(server.certSha256);
  });
});
