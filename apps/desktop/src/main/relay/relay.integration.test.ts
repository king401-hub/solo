import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { generateIdentity, pairingProof, randomNonce, rendezvousKey, signText } from "@solo/crypto";
import { createRelay } from "@solo/relay/server";
import { relayAuthText, type DeviceInfo, type Envelope } from "@solo/shared";
import { DeviceStore } from "../link/store";
import { createSync } from "../sync/sync";
import { RelayClient, validRelayUrl } from "./relayClient";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of cleanup.splice(0)) await c(); });
const until = async (f: () => boolean, ms = 4000) => { for (let i = 0; i < ms / 20 && !f(); i++) await new Promise((r) => setTimeout(r, 20)); };

async function startRelay() {
  const relay = createRelay({ host: "127.0.0.1" });
  const port = await relay.listen();
  cleanup.push(() => relay.close());
  return `ws://127.0.0.1:${port}`;
}

/** A complete device: identity, paired-device store, relay client and the real sync engine on top. */
function node(name: string, kind: "windows" | "android", url?: string) {
  const identity = generateIdentity();
  const dir = mkdtempSync(join(tmpdir(), "solo-relay-"));
  const store = new DeviceStore(join(dir, "devices.json"));
  const self = (): DeviceInfo => ({ deviceId: identity.id, kind, name, appVersion: "0.1.0", pub: identity.pub });
  const client = new RelayClient({ identity, self, store });
  const sync = createSync({ file: join(dir, "sync.json"), deviceId: identity.id, server: client, onChange: () => {} });
  const received: { from: string; env: Envelope }[] = [];
  const connected: string[] = [];
  const paired: string[] = [];
  client.on("message", (from, env) => received.push({ from, env }));
  client.on("connected", (d) => connected.push(d.deviceId));
  client.on("paired", (d) => paired.push(d.deviceId));
  cleanup.push(() => { client.stop(); sync.flush(); });
  if (url) client.setUrl(url);
  return { identity, store, client, sync: sync.store, received, connected, paired, name };
}
type Node = ReturnType<typeof node>;
const online = (n: Node) => until(() => n.client.status === "online");

/** Pair `joiner` to `host` over the relay with a code, the way the UI does. */
async function pair(host: Node, joiner: Node) {
  await online(host); await online(joiner);
  const { code } = host.client.hostPairing();
  const r = await joiner.client.joinPairing(code);
  expect(r.ok).toBe(true);
  await until(() => host.client.onlineDeviceIds.includes(joiner.identity.id) && joiner.client.onlineDeviceIds.includes(host.identity.id));
  return code;
}

describe("remote pairing over the relay", () => {
  it("pairs with a code, trusts each other's keys, and exchanges encrypted messages both ways", async () => {
    const url = await startRelay();
    const laptop = node("Work laptop", "windows", url), phone = node("Pixel", "android", url);
    await pair(laptop, phone);

    expect(laptop.store.get(phone.identity.id)?.device).toMatchObject({ name: "Pixel", kind: "android", pub: phone.identity.pub });
    expect(phone.store.get(laptop.identity.id)?.device).toMatchObject({ name: "Work laptop", kind: "windows", pub: laptop.identity.pub });
    expect(laptop.paired).toEqual([phone.identity.id]);

    expect(phone.client.send(laptop.identity.id, "task.update", { taskId: "t1", status: "running" })).toBe(true);
    await until(() => laptop.received.some((r) => r.env.type === "task.update"));
    expect(laptop.received.at(-1)).toMatchObject({ from: phone.identity.id, env: { type: "task.update", payload: { taskId: "t1" } } });

    laptop.client.send(phone.identity.id, "task.update", { taskId: "t1", status: "done" });
    await until(() => phone.received.some((r) => r.env.type === "task.update"));
    expect(phone.received.at(-1)!.env.payload).toMatchObject({ status: "done" });
  });

  it("a wrong or expired code fails cleanly and pairs nothing", async () => {
    const url = await startRelay();
    const laptop = node("L", "windows", url), phone = node("P", "android", url);
    await online(laptop); await online(phone);
    laptop.client.hostPairing();
    expect(await phone.client.joinPairing("AAAA-BBBB-CCCC")).toEqual({ ok: false, error: "Code not found or expired" });
    expect(await phone.client.joinPairing("short")).toEqual({ ok: false, error: "Enter the 12-character code" });
    expect(laptop.store.list()).toHaveLength(0);
    expect(phone.store.list()).toHaveLength(0);
  });

  it("the code works once; a second device cannot reuse it", async () => {
    const url = await startRelay();
    const laptop = node("L", "windows", url), a = node("A", "android", url), b = node("B", "android", url);
    const code = await pair(laptop, a);
    await online(b);
    expect(await b.client.joinPairing(code)).toMatchObject({ ok: false });
    expect(laptop.store.get(b.identity.id)).toBeUndefined();
  });

  it("locks after repeated bad proofs: a guesser who finds the rendezvous cannot keep trying", async () => {
    const url = await startRelay();
    const laptop = node("L", "windows", url);
    await online(laptop);
    const { code } = laptop.client.hostPairing();

    // An attacker that somehow learned the rendezvous key but not the code (the HMAC proof will never verify).
    const evil = generateIdentity();
    const ws = new WebSocket(url);
    cleanup.push(() => ws.terminate());
    const got: any[] = [];
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      got.push(m);
      if (m.t === "hello") ws.send(JSON.stringify({ t: "auth", pub: evil.pub, sig: signText(evil, relayAuthText(m.nonce)) }));
      if (m.t === "ready") ws.send(JSON.stringify({ t: "rdv.join", key: rendezvousKey(code) }));
    });
    await until(() => got.some((m) => m.t === "rdv.found"));
    const hostId = laptop.identity.id;
    for (let i = 0; i < 6; i++) {
      const nonce = randomNonce();
      const body = { k: "pair.req", device: { name: "evil", kind: "android", appVersion: "1" }, pub: evil.pub, nonce, proof: pairingProof("WRONG-CODE-0000", "req", hostId, evil.id, nonce, evil.pub, "") };
      ws.send(JSON.stringify({ t: "send", to: hostId, body: JSON.stringify(body) }));
      await new Promise((r) => setTimeout(r, 40));
    }
    await until(() => laptop.client.pairing === undefined);
    expect(laptop.client.pairing).toBeUndefined();
    expect(laptop.store.list()).toHaveLength(0);
    const replies = got.filter((m) => m.t === "msg").map((m) => JSON.parse(m.body).reason);
    expect(replies.slice(0, 5)).toEqual(Array(5).fill("bad_proof"));
    expect(replies.at(-1)).toBe("expired"); // pairing window is gone after the lockout
  });
});

describe("one phone, three laptops", () => {
  it("pairs with all three and every device converges on the same settings", async () => {
    const url = await startRelay();
    const phone = node("Pixel", "android", url);
    const laptops = [node("Home PC", "windows", url), node("Work laptop", "windows", url), node("Travel laptop", "windows", url)];
    for (const l of laptops) await pair(l, phone);
    expect(phone.store.list().map((d) => d.device.name).sort()).toEqual(["Home PC", "Travel laptop", "Work laptop"]);

    // phone edits -> all three laptops
    phone.sync.set("settings", "voice", { speechRate: 1.4, voiceGender: "female" });
    await until(() => laptops.every((l) => l.sync.get("settings", "voice")?.["speechRate"] === 1.4));
    for (const l of laptops) expect(l.sync.get("settings", "voice")).toEqual({ speechRate: 1.4, voiceGender: "female" });

    // a laptop edit -> phone AND the other two laptops (the phone relays between laptops that never met)
    laptops[1]!.sync.set("settings", "voice", { speechRate: 0.8, voiceGender: "male" });
    await until(() => [phone, laptops[0]!, laptops[2]!].every((n) => n.sync.get("settings", "voice")?.["speechRate"] === 0.8));
    for (const n of [phone, ...laptops]) expect(n.sync.get("settings", "voice")).toEqual({ speechRate: 0.8, voiceGender: "male" });

    // messages are addressed to one specific laptop and no other
    for (const l of laptops) l.received.length = 0;
    phone.client.send(laptops[2]!.identity.id, "task.dispatch", { taskId: "open-vscode" });
    await until(() => laptops[2]!.received.some((r) => r.env.type === "task.dispatch"));
    await new Promise((r) => setTimeout(r, 150));
    expect(laptops[0]!.received.filter((r) => r.env.type === "task.dispatch")).toHaveLength(0);
    expect(laptops[1]!.received.filter((r) => r.env.type === "task.dispatch")).toHaveLength(0);
  });

  it("a device that was offline catches up when it reconnects (no shared network needed, only the relay)", async () => {
    const url = await startRelay();
    const phone = node("Pixel", "android", url), laptop = node("Laptop", "windows", url);
    await pair(laptop, phone);
    phone.client.setUrl(undefined); // phone loses signal
    await until(() => !laptop.client.onlineDeviceIds.includes(phone.identity.id));
    laptop.sync.set("settings", "voice", { quickWord: false }); // edit while the phone is away
    phone.sync.set("settings", "other", { n: 1 }); // and the phone edits offline too
    phone.client.setUrl(url); // signal returns
    await until(() => phone.sync.get("settings", "voice")?.["quickWord"] === false && laptop.sync.get("settings", "other")?.["n"] === 1);
    expect(phone.sync.get("settings", "voice")).toEqual({ quickWord: false });
    expect(laptop.sync.get("settings", "other")).toEqual({ n: 1 });
  });
});

describe("trust boundaries", () => {
  it("ignores strangers: an unpaired device cannot open a session or inject messages", async () => {
    const url = await startRelay();
    const laptop = node("L", "windows", url);
    const stranger = node("Stranger", "android", url);
    await online(laptop); await online(stranger);
    // stranger knows the laptop id but is not in its trust store (and vice versa)
    laptop.store.add({ deviceId: "x".repeat(8), kind: "android", name: "unrelated", appVersion: "1" }, "t");
    stranger.store.add({ deviceId: laptop.identity.id, kind: "windows", name: "L", appVersion: "1", pub: laptop.identity.pub }, "t");
    stranger.client.refreshWatch();
    stranger.client.send(laptop.identity.id, "task.dispatch", { taskId: "evil" });
    await new Promise((r) => setTimeout(r, 300));
    expect(laptop.received).toHaveLength(0);
    expect(laptop.connected).toHaveLength(0);
    expect(laptop.client.onlineDeviceIds).toEqual([]);
  });

  it("revoking a device cuts it off even though the relay still carries its frames", async () => {
    const url = await startRelay();
    const laptop = node("L", "windows", url), phone = node("P", "android", url);
    await pair(laptop, phone);
    laptop.received.length = 0;
    laptop.store.revoke(phone.identity.id);
    phone.client.send(laptop.identity.id, "task.dispatch", { taskId: "after-revoke" });
    await new Promise((r) => setTimeout(r, 300));
    expect(laptop.received).toHaveLength(0);
  });

  it("accepts only wss:// relays (ws:// only for loopback/private hosts)", () => {
    expect(validRelayUrl("wss://solo-relay.fly.dev")).toBe(true);
    expect(validRelayUrl("ws://127.0.0.1:8080")).toBe(true);
    expect(validRelayUrl("ws://192.168.1.5:8080")).toBe(true);
    expect(validRelayUrl("ws://relay.example.com")).toBe(false);
    expect(validRelayUrl("https://relay.example.com")).toBe(false);
    expect(validRelayUrl("not a url")).toBe(false);
  });
});
