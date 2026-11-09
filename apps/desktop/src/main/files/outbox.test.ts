import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FILE_CHUNK_BYTES, FILE_WINDOW, parseEnvelope } from "@solo/shared";
import { Inbox } from "./inbox";
import { Outbox } from "./outbox";

let dir: string;
let clock: number;
let inbox: Inbox;
let outbox: Outbox;
let online: boolean;
let inFlight: number; // chunks sent but not yet acknowledged, to prove the window is respected
let maxInFlight: number;
let n = 0;

const env = (from: string, type: string, payload: unknown) => {
  const e = parseEnvelope({ v: 1, id: `m${n++}`, ts: 1, from, type, payload });
  if (!e) throw new Error(`invalid ${type}`);
  return e;
};
const tick = () => new Promise<void>((r) => setImmediate(r));
async function until(f: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!f() && Date.now() < end) await tick();
  if (!f()) throw new Error("condition not met");
}

function setup(maxBytes?: number) {
  inbox = new Inbox({
    dir: join(dir, "in"), indexFile: join(dir, "idx.json"), deviceName: () => "My PC", onChange: () => {}, maxBytes,
    // phone -> PC direction of the loopback (replies, acks and results)
    send: (to, type, payload) => { setTimeout(() => { if (type === "file.ack") inFlight--; outbox.handle("phone", env("phone", type, payload)); }, type === "file.ack" ? 3 : 0); return true; }, // acks are slow, like a real network, so the window fills
  });
  outbox = new Outbox({
    deviceName: () => "My phone", onChange: () => {}, now: () => clock,
    send: (_to, type, payload) => {
      if (!online) return false;
      if (type === "file.chunk") { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); }
      setImmediate(() => inbox.handle("pc", env("pc", type, payload)));
      return true;
    },
  });
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "solo-outbox-")); clock = 1000; online = true; inFlight = 0; maxInFlight = 0; setup(); });
afterEach(() => { outbox.stop(); inbox.stop(); rmSync(dir, { recursive: true, force: true }); });

const make = (name: string, data: Buffer) => { const p = join(dir, name); writeFileSync(p, data); return p; };

describe("sending from the computer", () => {
  it("delivers identical bytes across many chunks, never more than the window in flight", async () => {
    const data = Buffer.from(Array.from({ length: FILE_CHUNK_BYTES * 30 + 99 }, (_, i) => (i * 7) % 253));
    expect(await outbox.sendFile("phone", make("movie.bin", data))).toBeUndefined();
    await until(() => outbox.transfers[0]?.status === "done");
    expect(readFileSync(join(dir, "in", "movie.bin")).equals(data)).toBe(true);
    expect(maxInFlight).toBeLessThanOrEqual(FILE_WINDOW);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(outbox.transfers[0]!.sent).toBe(data.length);
  });

  it("sends an empty file", async () => {
    await outbox.sendFile("phone", make("empty.txt", Buffer.alloc(0)));
    await until(() => outbox.transfers[0]?.status === "done");
    expect(readFileSync(join(dir, "in", "empty.txt")).length).toBe(0);
  });

  it("shows the receiver's refusal", async () => {
    outbox.stop(); inbox.stop(); setup(10);
    await outbox.sendFile("phone", make("big.bin", Buffer.alloc(50)));
    await until(() => outbox.transfers[0]?.status === "failed");
    expect(outbox.transfers[0]!.error).toMatch(/too large/);
    expect(readdirSync(join(dir, "in"))).toEqual([]);
  });

  it("fails clearly when the device is not reachable", async () => {
    online = false;
    await outbox.sendFile("phone", make("a.txt", Buffer.from("x")));
    expect(outbox.transfers[0]!.status).toBe("failed");
    expect(outbox.transfers[0]!.error).toMatch(/not reachable/);
  });

  it("refuses folders and missing files before sending anything", async () => {
    expect(await outbox.sendFile("phone", dir)).toMatch(/not folders/);
    expect(await outbox.sendFile("phone", join(dir, "nope.txt"))).toMatch(/not be found/);
    expect(outbox.transfers).toEqual([]);
  });

  it("cancel stops the transfer and leaves no partial file at the other end", async () => {
    const id = (await outbox.sendFile("phone", make("c.bin", Buffer.alloc(FILE_CHUNK_BYTES * 40)))) ?? "";
    expect(id).toBe("");
    await until(() => (outbox.transfers[0]?.sent ?? 0) > 0);
    outbox.cancel(outbox.transfers[0]!.id);
    await tick(); await tick(); await tick();
    expect(outbox.transfers[0]!.status).toBe("cancelled");
    expect(readdirSync(join(dir, "in")).filter((f) => f.endsWith(".part") || f === "c.bin")).toEqual([]);
  });

  it("a device going offline fails its transfers", async () => {
    outbox.stop(); inbox.stop();
    inbox = new Inbox({ dir: join(dir, "in"), indexFile: join(dir, "idx.json"), deviceName: () => "x", onChange: () => {}, send: () => true });
    outbox = new Outbox({ deviceName: () => "My phone", onChange: () => {}, send: () => true, now: () => clock });
    await outbox.sendFile("phone", make("d.bin", Buffer.alloc(100)));
    outbox.peerLost("phone");
    expect(outbox.transfers[0]!.status).toBe("failed");
    expect(outbox.transfers[0]!.error).toMatch(/went offline/);
  });

  it("gives up when nothing answers", async () => {
    outbox.stop();
    outbox = new Outbox({ deviceName: () => "My phone", onChange: () => {}, send: () => true, now: () => clock, idleMs: 1000 });
    await outbox.sendFile("phone", make("e.bin", Buffer.alloc(10)));
    clock += 5000;
    (outbox as unknown as { check(): void }).check();
    expect(outbox.transfers[0]!.status).toBe("failed");
    expect(outbox.transfers[0]!.error).toMatch(/No answer/);
  });

  it("ignores messages about unknown transfers or from the wrong device", async () => {
    await outbox.sendFile("phone", make("f.bin", Buffer.alloc(10)));
    const id = outbox.transfers[0]!.id;
    expect(outbox.handle("someone-else", env("someone-else", "file.reply", { transferId: id, ok: false }))).toBe(false);
    expect(outbox.handle("phone", env("phone", "file.reply", { transferId: "unknown-transfer-id", ok: true }))).toBe(false);
    expect(outbox.handle("phone", env("phone", "heartbeat", {}))).toBe(false);
  });
});
