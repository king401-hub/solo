import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { generateIdentity, rendezvousKey, signText, type Identity } from "@solo/crypto";
import { relayAuthText } from "@solo/shared";
import { createRelay, type RelayOptions } from "./server";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of cleanup.splice(0)) await c(); });

async function start(opts: RelayOptions = {}) {
  const relay = createRelay({ host: "127.0.0.1", ...opts });
  const port = await relay.listen();
  cleanup.push(() => relay.close());
  return { relay, url: `ws://127.0.0.1:${port}` };
}

/** A test device: authenticates like a real one and collects what the relay sends it. */
async function device(url: string, id: Identity = generateIdentity(), signWith: Identity = id) {
  const ws = new WebSocket(url);
  cleanup.push(() => ws.terminate());
  const inbox: any[] = [];
  const waiters: { match: (m: any) => boolean; res: (m: any) => void }[] = [];
  let closeCode = 0;
  ws.on("message", (d) => {
    const m = JSON.parse(d.toString());
    if (m.t === "hello") ws.send(JSON.stringify({ t: "auth", pub: id.pub, sig: signText(signWith, relayAuthText(m.nonce)) }));
    const w = waiters.findIndex((x) => x.match(m));
    if (w >= 0) waiters.splice(w, 1)[0]!.res(m); else inbox.push(m);
  });
  ws.on("close", (c) => { closeCode = c; });
  const next = (match: (m: any) => boolean = () => true, ms = 2000) => new Promise<any>((res, rej) => {
    const i = inbox.findIndex(match);
    if (i >= 0) return res(inbox.splice(i, 1)[0]);
    const t = setTimeout(() => rej(new Error("timeout waiting for message")), ms);
    waiters.push({ match, res: (m) => { clearTimeout(t); res(m); } });
  });
  const send = (m: unknown) => ws.send(JSON.stringify(m));
  const ready = id === signWith ? await next((m) => m.t === "ready") : undefined;
  return { id, ws, send, next, ready, inbox, get closeCode() { return closeCode; } };
}
const until = async (f: () => boolean, ms = 2000) => { for (let i = 0; i < ms / 20 && !f(); i++) await new Promise((r) => setTimeout(r, 20)); };

describe("authentication", () => {
  it("accepts a valid signature and reports the key-derived id", async () => {
    const { url } = await start();
    const d = await device(url);
    expect(d.ready.id).toBe(d.id.id);
  });
  it("rejects a signature made with another key (cannot claim someone else's id)", async () => {
    const { url } = await start();
    const victim = generateIdentity(), attacker = generateIdentity();
    const d = await device(url, victim, attacker);
    await until(() => d.closeCode !== 0);
    expect(d.closeCode).toBe(4401);
  });
  it("ignores everything before auth and times out silent clients", async () => {
    const { url, relay } = await start({ authTimeoutMs: 150 });
    const ws = new WebSocket(url);
    cleanup.push(() => ws.terminate());
    await new Promise<void>((r) => ws.on("open", () => r()));
    ws.send(JSON.stringify({ t: "send", to: "a".repeat(64), body: "x" }));
    const code = await new Promise<number>((r) => ws.on("close", (c) => r(c)));
    expect(code).toBe(4408);
    expect(relay.stats().online).toBe(0);
  });
  it("a newer connection with the same key replaces the old one", async () => {
    const { url, relay } = await start();
    const id = generateIdentity();
    const a = await device(url, id);
    const b = await device(url, id);
    await until(() => a.closeCode !== 0);
    expect(a.closeCode).toBe(4409);
    expect(relay.stats().online).toBe(1);
    void b;
  });
});

describe("routing (one phone, three laptops)", () => {
  it("delivers opaque bodies by id and tells the sender when the target is offline", async () => {
    const { url } = await start();
    const phone = await device(url);
    const laptops = await Promise.all([device(url), device(url), device(url)]);
    for (const [i, l] of laptops.entries()) {
      phone.send({ t: "send", to: l.id.id, body: `for-laptop-${i}` });
      expect(await l.next((m) => m.t === "msg")).toEqual({ t: "msg", from: phone.id.id, body: `for-laptop-${i}` });
    }
    laptops[1]!.send({ t: "send", to: phone.id.id, body: "hi phone" });
    expect((await phone.next((m) => m.t === "msg")).from).toBe(laptops[1]!.id.id);
    const ghost = generateIdentity().id;
    phone.send({ t: "send", to: ghost, body: "x" });
    expect(await phone.next((m) => m.t === "offline")).toEqual({ t: "offline", to: ghost });
  });

  it("does not leak messages to third parties", async () => {
    const { url } = await start();
    const [a, b, spy] = await Promise.all([device(url), device(url), device(url)]);
    a.send({ t: "send", to: b.id.id, body: "private" });
    await b.next((m) => m.t === "msg");
    await new Promise((r) => setTimeout(r, 100));
    expect(spy.inbox.filter((m) => m.t === "msg")).toHaveLength(0);
  });

  it("rejects malformed frames without dropping the connection", async () => {
    const { url } = await start();
    const a = await device(url);
    const b = await device(url);
    a.ws.send("not json");
    expect((await a.next((m) => m.t === "error")).code).toBe("bad_frame");
    a.send({ t: "nonsense" });
    expect((await a.next((m) => m.t === "error")).code).toBe("bad_frame");
    a.send({ t: "send", to: b.id.id, body: "still works" });
    expect((await b.next((m) => m.t === "msg")).body).toBe("still works");
  });

  it("closes a connection that sends a frame above the size cap", async () => {
    const { url } = await start();
    const a = await device(url);
    const b = await device(url);
    a.send({ t: "send", to: b.id.id, body: "x".repeat(300 * 1024) });
    await until(() => a.closeCode !== 0);
    expect([1009, 1006]).toContain(a.closeCode); // 1009 if the close handshake completes, 1006 if the socket drops mid-frame
    expect(b.inbox.filter((m) => m.t === "msg")).toHaveLength(0);
  });
});

describe("presence", () => {
  it("peers reports who is online; watch pushes online/offline changes", async () => {
    const { url } = await start();
    const phone = await device(url);
    const laptopId = generateIdentity();
    phone.send({ t: "peers", ids: [laptopId.id, phone.id.id] });
    expect((await phone.next((m) => m.t === "peers")).online).toEqual([phone.id.id]);
    phone.send({ t: "watch", ids: [laptopId.id] });
    const laptop = await device(url, laptopId);
    expect(await phone.next((m) => m.t === "presence")).toEqual({ t: "presence", id: laptopId.id, online: true });
    laptop.ws.close();
    expect(await phone.next((m) => m.t === "presence")).toEqual({ t: "presence", id: laptopId.id, online: false });
  });
});

describe("rendezvous (remote pairing)", () => {
  const code = "K7QM-2X9D-4TRW";

  it("joins a joiner to the host that opened the same key and tells both sides", async () => {
    const { url } = await start();
    const host = await device(url), joiner = await device(url);
    host.send({ t: "rdv.open", key: rendezvousKey(code) });
    await host.next((m) => m.t === "rdv.opened");
    joiner.send({ t: "rdv.join", key: rendezvousKey(code) });
    expect(await joiner.next((m) => m.t === "rdv.found")).toEqual({ t: "rdv.found", host: host.id.id });
    expect(await host.next((m) => m.t === "rdv.joined")).toEqual({ t: "rdv.joined", joiner: joiner.id.id });
  });

  it("unknown keys get rdv.none; the key is useless after the host closes or disconnects", async () => {
    const { url } = await start();
    const host = await device(url), joiner = await device(url);
    joiner.send({ t: "rdv.join", key: rendezvousKey("0000-0000-0000") });
    await joiner.next((m) => m.t === "rdv.none");
    host.send({ t: "rdv.open", key: rendezvousKey(code) });
    await host.next((m) => m.t === "rdv.opened");
    host.send({ t: "rdv.close" });
    await new Promise((r) => setTimeout(r, 50));
    joiner.send({ t: "rdv.join", key: rendezvousKey(code) });
    await joiner.next((m) => m.t === "rdv.none");
  });

  it("expires after the TTL", async () => {
    let now = 1_000_000;
    const { url } = await start({ now: () => now, rdvTtlMs: 60_000 });
    const host = await device(url), joiner = await device(url);
    host.send({ t: "rdv.open", key: rendezvousKey(code) });
    await host.next((m) => m.t === "rdv.opened");
    now += 61_000;
    joiner.send({ t: "rdv.join", key: rendezvousKey(code) });
    await joiner.next((m) => m.t === "rdv.none");
  });

  it("blocks an IP that keeps guessing keys", async () => {
    const { url } = await start({ maxFailedJoins: 3, blockMs: 60_000 });
    const g = await device(url);
    for (let i = 0; i < 3; i++) {
      g.send({ t: "rdv.join", key: rendezvousKey(`guess-${i}`) });
      await g.next((m) => m.t === "rdv.none");
    }
    g.send({ t: "rdv.join", key: rendezvousKey("guess-4") });
    await until(() => g.closeCode !== 0);
    expect(g.closeCode).toBe(4429);
    const g2 = await device(url); // same IP, new connection: still blocked
    g2.send({ t: "rdv.join", key: rendezvousKey("guess-5") });
    await until(() => g2.closeCode !== 0);
    expect(g2.closeCode).toBe(4429);
  });
});

describe("abuse limits", () => {
  it("rate limits a flooding connection", async () => {
    const { url } = await start({ ratePerSec: 5 });
    const a = await device(url), b = await device(url);
    for (let i = 0; i < 60; i++) a.send({ t: "send", to: b.id.id, body: String(i) });
    const err = await a.next((m) => m.t === "error" && m.code === "rate");
    expect(err.code).toBe("rate");
  });
  it("caps connections per IP", async () => {
    const { url } = await start({ maxConnectionsPerIp: 2 });
    await device(url); await device(url);
    const third = new WebSocket(url);
    cleanup.push(() => third.terminate());
    const code = await new Promise<number>((r) => third.on("close", (c) => r(c)));
    expect(code).toBe(1013);
  });
  it("serves a health check", async () => {
    const { url } = await start();
    const res = await fetch(url.replace("ws://", "http://") + "/healthz");
    expect(await res.text()).toBe("ok");
  });
});
