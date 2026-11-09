import { createHash, randomUUID, type Hash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { FILE_WINDOW, MAX_FILE_BYTES, type Envelope } from "@solo/shared";

export interface ReceivedFile { id: string; name: string; from: string; fromName: string; size: number; at: number; path: string }
export interface ActiveReceive { transferId: string; name: string; from: string; fromName: string; size: number; received: number }

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** A file name that is safe to create in a Windows folder: no path parts, no reserved characters or device names. */
export function safeName(raw: string): string {
  let n = basename(raw.replace(/\\/g, "/")).replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_").replace(/[. ]+$/g, "").trim();
  if (!n || n === "." || n === "..") n = "file";
  const ext = extname(n);
  const stem = ext ? n.slice(0, -ext.length) : n;
  if (RESERVED.test(stem)) n = `_${n}`;
  if (n.length > 150) n = n.slice(0, 150 - ext.length) + ext;
  return n;
}

/** name, then "name (1).ext", "name (2).ext" ... so a received file never replaces an existing one. */
export function uniquePath(dir: string, name: string, exists: (p: string) => boolean = existsSync): string {
  const ext = extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  let p = join(dir, name);
  for (let i = 1; exists(p); i++) p = join(dir, `${stem} (${i})${ext}`);
  return p;
}

interface Transfer {
  from: string; name: string; size: number; received: number; next: number; fd: number; part: string; hash: Hash; lastAt: number; ended: boolean;
}

export interface InboxDeps {
  /** Where received files are saved (created on demand). */
  dir: string;
  send(to: string, type: Envelope["type"], payload: unknown): boolean;
  deviceName(id: string): string;
  /** Persisted list of received files. */
  indexFile: string;
  onChange(): void;
  now?: () => number;
  maxBytes?: number;
}

const IDLE_MS = 60_000;
const MAX_ACTIVE = 4;
const KEEP = 50;

/**
 * Receives files from paired phones/laptops. Files only ever go into one folder, are never opened or run, never replace
 * an existing file, and only appear under their final name once the size and SHA-256 match what the sender announced.
 */
export class Inbox {
  private active = new Map<string, Transfer>();
  private list: ReceivedFile[] = [];
  private timer?: NodeJS.Timeout;
  private readonly now: () => number;
  private readonly max: number;

  constructor(private d: InboxDeps) {
    this.now = d.now ?? Date.now;
    this.max = Math.min(d.maxBytes ?? MAX_FILE_BYTES, MAX_FILE_BYTES);
    try { const j = JSON.parse(readFileSync(d.indexFile, "utf8")); if (Array.isArray(j)) this.list = j.filter((f) => f && typeof f.path === "string").slice(0, KEEP); } catch { /* none yet */ }
    this.timer = setInterval(() => this.sweep(), 10_000);
    this.timer.unref();
  }

  get folder() { return this.d.dir; }
  received(): ReceivedFile[] { return this.list.filter((f) => existsSync(f.path)); }
  receiving(): ActiveReceive[] {
    return [...this.active].map(([transferId, t]) => ({ transferId, name: t.name, from: t.from, fromName: this.d.deviceName(t.from), size: t.size, received: t.received }));
  }
  forget(id: string) { this.list = this.list.filter((f) => f.id !== id); this.save(); this.d.onChange(); }

  private key(from: string, tid: string) { return `${from}:${tid}`; }
  private save() { try { writeFileSync(this.d.indexFile, JSON.stringify(this.list.slice(0, KEEP))); } catch { /* best effort */ } }

  private drop(key: string) {
    const t = this.active.get(key);
    if (!t) return;
    try { closeSync(t.fd); } catch { /* already closed */ }
    try { rmSync(t.part, { force: true }); } catch { /* ignore */ }
    this.active.delete(key);
    this.d.onChange();
  }

  private sweep() {
    for (const [k, t] of this.active) if (this.now() - t.lastAt > IDLE_MS) this.drop(k);
  }

  stop() { if (this.timer) clearInterval(this.timer); for (const k of [...this.active.keys()]) this.drop(k); }

  /** Handle one message from a paired device. Returns true if it was a file message. */
  handle(from: string, env: Envelope): boolean {
    switch (env.type) {
      case "file.offer": this.offer(from, env.payload); return true;
      case "file.chunk": this.chunk(from, env.payload); return true;
      case "file.end": this.end(from, env.payload); return true;
      case "file.cancel": this.drop(this.key(from, env.payload.transferId)); return true;
      default: return false;
    }
  }

  private offer(from: string, p: { transferId: string; name: string; size: number }) {
    const reply = (ok: boolean, reason?: string) => this.d.send(from, "file.reply", { transferId: p.transferId, ok, reason });
    const k = this.key(from, p.transferId);
    if (this.active.has(k)) return reply(false, "Already receiving this file");
    if (p.size > this.max) return reply(false, "That file is too large (limit 2 GB)");
    if (this.active.size >= MAX_ACTIVE) return reply(false, "Busy receiving other files, try again in a moment");
    let fd: number;
    const part = join(this.d.dir, `.solo-${randomUUID()}.part`);
    try { mkdirSync(this.d.dir, { recursive: true }); fd = openSync(part, "wx"); }
    catch { return reply(false, "The computer could not create the file (is the disk full or the folder blocked?)"); }
    this.active.set(k, { from, name: safeName(p.name), size: p.size, received: 0, next: 0, fd, part, hash: createHash("sha256"), lastAt: this.now(), ended: false });
    this.d.onChange();
    reply(true);
  }

  private chunk(from: string, p: { transferId: string; seq: number; data: string }) {
    const k = this.key(from, p.transferId);
    const t = this.active.get(k);
    if (!t || t.ended) return;
    const cancel = (reason: string) => { this.d.send(from, "file.cancel", { transferId: p.transferId, reason }); this.drop(k); };
    if (p.seq !== t.next) return cancel("Chunks arrived out of order");
    const buf = Buffer.from(p.data, "base64");
    if (t.received + buf.length > t.size) return cancel("More data than announced");
    try { writeSync(t.fd, buf); } catch { return cancel("The computer could not write the file (disk full?)"); }
    t.hash.update(buf);
    t.received += buf.length;
    t.next++;
    t.lastAt = this.now();
    this.d.send(from, "file.ack", { transferId: p.transferId, seq: p.seq });
    if (p.seq % Math.max(1, FILE_WINDOW) === 0) this.d.onChange();
  }

  private end(from: string, p: { transferId: string; sha256: string }) {
    const k = this.key(from, p.transferId);
    const t = this.active.get(k);
    if (!t) return;
    const fail = (reason: string) => { this.d.send(from, "file.result", { transferId: p.transferId, ok: false, reason }); this.drop(k); };
    t.ended = true;
    if (t.received !== t.size) return fail("The file arrived incomplete");
    if (t.hash.digest("hex") !== p.sha256) return fail("The file was damaged in transit (checksum mismatch)");
    try { closeSync(t.fd); } catch { /* ignore */ }
    const final = uniquePath(this.d.dir, t.name);
    try { renameSync(t.part, final); } catch { return fail("The computer could not save the file"); }
    this.active.delete(k);
    this.list.unshift({ id: p.transferId, name: basename(final), from, fromName: this.d.deviceName(from), size: t.size, at: this.now(), path: final });
    this.list = this.list.slice(0, KEEP);
    this.save();
    this.d.send(from, "file.result", { transferId: p.transferId, ok: true });
    this.d.onChange();
  }
}
