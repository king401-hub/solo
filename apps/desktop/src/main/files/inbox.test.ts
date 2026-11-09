import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FILE_CHUNK_BYTES, parseEnvelope, type Envelope } from "@solo/shared";
import { Inbox, safeName, uniquePath } from "./inbox";

let dir: string;
let sent: { to: string; type: string; payload: Record<string, unknown> }[];
let clock: number;
let inbox: Inbox;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "solo-inbox-"));
  sent = [];
  clock = 1000;
  inbox = new Inbox({
    dir: join(dir, "Solo"), indexFile: join(dir, "index.json"), deviceName: () => "My phone", onChange: () => {}, now: () => clock,
    send: (to, type, payload) => { sent.push({ to, type, payload: payload as Record<string, unknown> }); return true; },
  });
});
afterEach(() => { inbox.stop(); rmSync(dir, { recursive: true, force: true }); });

let n = 0;
function env(type: string, payload: unknown): Envelope {
  const e = parseEnvelope({ v: 1, id: `m${n++}`, ts: 1, from: "phone-1", type, payload });
  if (!e) throw new Error(`invalid ${type} envelope`);
  return e;
}
const tid = (s: string) => `tid-${s}-12345678`;
const last = (type: string) => [...sent].reverse().find((m) => m.type === type);

function sendAll(id: string, name: string, data: Buffer, tamper = false) {
  inbox.handle("phone-1", env("file.offer", { transferId: id, name, size: data.length }));
  let seq = 0;
  for (let o = 0; o < data.length; o += FILE_CHUNK_BYTES) inbox.handle("phone-1", env("file.chunk", { transferId: id, seq: seq++, data: data.subarray(o, o + FILE_CHUNK_BYTES).toString("base64") }));
  const sha = createHash("sha256").update(data).digest("hex");
  inbox.handle("phone-1", env("file.end", { transferId: id, sha256: tamper ? "0".repeat(64) : sha }));
}

describe("file names", () => {
  it("never lets a name escape the folder or use Windows device names", () => {
    expect(safeName("..\\..\\Windows\\evil.exe")).toBe("evil.exe");
    expect(safeName("../../etc/passwd")).toBe("passwd");
    expect(safeName("a<b>c:d?.txt")).toBe("a_b_c_d_.txt");
    expect(safeName("CON.txt")).toBe("_CON.txt");
    expect(safeName("report. ")).toBe("report");
    expect(safeName("..")).toBe("file");
    expect(safeName("x".repeat(400) + ".pdf").length).toBeLessThanOrEqual(150);
  });
  it("picks a new name instead of replacing a file", () => {
    const have = new Set([join("d", "a.txt"), join("d", "a (1).txt")]);
    expect(uniquePath("d", "a.txt", (p) => have.has(p))).toBe(join("d", "a (2).txt"));
  });
});

describe("receiving a file", () => {
  it("accepts, saves under the right name with identical bytes, and confirms", () => {
    const data = Buffer.from(Array.from({ length: FILE_CHUNK_BYTES * 3 + 123 }, (_, i) => (i * 31) % 251));
    sendAll(tid("a"), "photo.jpg", data);
    expect(last("file.reply")?.payload["ok"]).toBe(true);
    expect(sent.filter((m) => m.type === "file.ack").map((m) => m.payload["seq"])).toEqual([0, 1, 2, 3]);
    expect(last("file.result")?.payload["ok"]).toBe(true);
    const f = inbox.received();
    expect(f).toHaveLength(1);
    expect(f[0]!.name).toBe("photo.jpg");
    expect(f[0]!.fromName).toBe("My phone");
    expect(readFileSync(f[0]!.path).equals(data)).toBe(true);
    expect(readdirSync(join(dir, "Solo")).filter((x) => x.endsWith(".part"))).toEqual([]);
  });

  it("handles an empty file and a second file with the same name without overwriting", () => {
    sendAll(tid("e"), "notes.txt", Buffer.alloc(0));
    sendAll(tid("f"), "notes.txt", Buffer.from("second"));
    const names = inbox.received().map((x) => x.name).sort();
    expect(names).toEqual(["notes (1).txt", "notes.txt"]);
    expect(readFileSync(join(dir, "Solo", "notes.txt")).length).toBe(0);
  });

  it("rejects a damaged file and leaves nothing behind", () => {
    sendAll(tid("b"), "doc.pdf", Buffer.from("hello world"), true);
    const r = last("file.result")!;
    expect(r.payload["ok"]).toBe(false);
    expect(String(r.payload["reason"])).toMatch(/checksum/);
    expect(readdirSync(join(dir, "Solo"))).toEqual([]);
    expect(inbox.received()).toEqual([]);
  });

  it("rejects an incomplete file", () => {
    const id = tid("c");
    inbox.handle("phone-1", env("file.offer", { transferId: id, name: "x.bin", size: 100 }));
    inbox.handle("phone-1", env("file.chunk", { transferId: id, seq: 0, data: Buffer.alloc(40).toString("base64") }));
    inbox.handle("phone-1", env("file.end", { transferId: id, sha256: createHash("sha256").update(Buffer.alloc(40)).digest("hex") }));
    expect(last("file.result")?.payload["ok"]).toBe(false);
    expect(readdirSync(join(dir, "Solo"))).toEqual([]);
  });

  it("cancels on a gap in the chunks and cleans up", () => {
    const id = tid("d");
    inbox.handle("phone-1", env("file.offer", { transferId: id, name: "x.bin", size: 200000 }));
    inbox.handle("phone-1", env("file.chunk", { transferId: id, seq: 1, data: "AAAA" }));
    expect(last("file.cancel")).toBeTruthy();
    expect(inbox.receiving()).toEqual([]);
    expect(readdirSync(join(dir, "Solo"))).toEqual([]);
  });

  it("refuses data beyond the announced size", () => {
    const id = tid("g");
    inbox.handle("phone-1", env("file.offer", { transferId: id, name: "x.bin", size: 3 }));
    inbox.handle("phone-1", env("file.chunk", { transferId: id, seq: 0, data: Buffer.alloc(10).toString("base64") }));
    expect(last("file.cancel")).toBeTruthy();
  });

  it("refuses oversize offers and too many at once", () => {
    const small = new Inbox({ dir: join(dir, "S"), indexFile: join(dir, "i2.json"), deviceName: () => "p", onChange: () => {}, maxBytes: 100, send: (to, type, payload) => { sent.push({ to, type, payload: payload as Record<string, unknown> }); return true; } });
    small.handle("phone-1", env("file.offer", { transferId: tid("h"), name: "big", size: 101 }));
    expect(last("file.reply")?.payload["ok"]).toBe(false);
    small.stop();
    for (let i = 0; i < 5; i++) inbox.handle("phone-1", env("file.offer", { transferId: tid(`m${i}`), name: `f${i}`, size: 10 }));
    expect(sent.filter((m) => m.type === "file.reply" && m.payload["ok"] === true)).toHaveLength(4);
    expect(last("file.reply")?.payload["ok"]).toBe(false);
  });

  it("drops a transfer that goes quiet", () => {
    inbox.handle("phone-1", env("file.offer", { transferId: tid("q"), name: "x", size: 10 }));
    expect(inbox.receiving()).toHaveLength(1);
    clock += 120_000;
    (inbox as unknown as { sweep(): void }).sweep();
    expect(inbox.receiving()).toEqual([]);
    expect(readdirSync(join(dir, "Solo"))).toEqual([]);
  });

  it("a cancel from the sender removes the partial file", () => {
    const id = tid("z");
    inbox.handle("phone-1", env("file.offer", { transferId: id, name: "x", size: 100 }));
    inbox.handle("phone-1", env("file.cancel", { transferId: id }));
    expect(inbox.receiving()).toEqual([]);
    expect(readdirSync(join(dir, "Solo"))).toEqual([]);
  });

  it("two devices using the same transfer id do not collide", () => {
    inbox.handle("phone-1", env("file.offer", { transferId: tid("s"), name: "a", size: 1 }));
    inbox.handle("laptop-2", env("file.offer", { transferId: tid("s"), name: "b", size: 1 }));
    expect(sent.filter((m) => m.type === "file.reply").map((m) => m.payload["ok"])).toEqual([true, true]);
  });

  it("remembers received files across restarts, and forgets files deleted from disk", () => {
    sendAll(tid("r"), "keep.txt", Buffer.from("abc"));
    const again = new Inbox({ dir: join(dir, "Solo"), indexFile: join(dir, "index.json"), deviceName: () => "p", onChange: () => {}, send: () => true });
    expect(again.received().map((f) => f.name)).toEqual(["keep.txt"]);
    rmSync(join(dir, "Solo", "keep.txt"));
    expect(again.received()).toEqual([]);
    again.stop();
    expect(existsSync(join(dir, "index.json"))).toBe(true);
  });
});
