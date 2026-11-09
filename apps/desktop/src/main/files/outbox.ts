import { createHash, randomBytes, type Hash } from "node:crypto";
import { open, stat, type FileHandle } from "node:fs/promises";
import { basename } from "node:path";
import { FILE_CHUNK_BYTES, FILE_WINDOW, MAX_FILE_BYTES, type Envelope } from "@solo/shared";

export type TransferStatus = "waiting" | "sending" | "finishing" | "done" | "failed" | "cancelled";
export interface Transfer {
  id: string; name: string; size: number; sent: number; status: TransferStatus; error?: string; to: string; toName: string;
}

interface Out {
  info: Transfer; fh: FileHandle; hash: Hash; nextSeq: number; acked: number; offset: number;
  eof: boolean; endSent: boolean; pumping: boolean; lastAt: number;
}

export interface OutboxDeps {
  send(to: string, type: Envelope["type"], payload: unknown): boolean;
  deviceName(id: string): string;
  onChange(): void;
  now?: () => number;
  idleMs?: number;
}

/**
 * Sends files from this computer to a paired device (the mirror of the phone's FileSender). Same protocol as
 * packages/shared/src/protocol.ts: offer, wait for the reply, stream chunks with a small window, then end with the SHA-256.
 */
export class Outbox {
  private out = new Map<string, Out>();
  private history: Transfer[] = [];
  private timer?: NodeJS.Timeout;
  private readonly now: () => number;
  private readonly idleMs: number;

  constructor(private d: OutboxDeps) {
    this.now = d.now ?? Date.now;
    this.idleMs = d.idleMs ?? 45_000;
    this.timer = setInterval(() => this.check(), 5_000);
    this.timer.unref();
  }

  get transfers(): Transfer[] { return [...[...this.out.values()].map((o) => o.info), ...this.history]; }

  /** Starts sending [path] to [to]. Returns an error message, or undefined if the transfer started. */
  async sendFile(to: string, path: string, name = basename(path)): Promise<string | undefined> {
    let size: number;
    try {
      const st = await stat(path);
      if (!st.isFile()) return "Only files can be sent, not folders.";
      size = st.size;
    } catch { return "That file could not be found."; }
    if (size > MAX_FILE_BYTES) return "That file is larger than 2 GB.";
    let fh: FileHandle;
    try { fh = await open(path, "r"); } catch { return "That file could not be opened (is another program using it?)."; }
    const id = randomBytes(12).toString("hex");
    const o: Out = {
      info: { id, name, size, sent: 0, status: "waiting", to, toName: this.d.deviceName(to) },
      fh, hash: createHash("sha256"), nextSeq: 0, acked: 0, offset: 0, eof: false, endSent: false, pumping: false, lastAt: this.now(),
    };
    this.out.set(id, o);
    this.d.onChange();
    if (!this.d.send(to, "file.offer", { transferId: id, name, size })) this.finish(o, "failed", `${o.info.toName} is not reachable right now. Check that Solo is running on it.`);
    return undefined;
  }

  cancel(id: string) {
    const o = this.out.get(id);
    if (!o) return;
    this.d.send(o.info.to, "file.cancel", { transferId: id });
    this.finish(o, "cancelled");
  }

  clearFinished() { this.history = []; this.d.onChange(); }

  /** A device went offline: fail what was headed there. */
  peerLost(id: string) {
    for (const o of [...this.out.values()]) if (o.info.to === id) this.finish(o, "failed", `${o.info.toName} went offline. Send the file again when it is back.`);
  }

  stop() { if (this.timer) clearInterval(this.timer); for (const o of [...this.out.values()]) this.finish(o, "cancelled"); }

  private finish(o: Out, status: TransferStatus, error?: string) {
    if (!this.out.delete(o.info.id)) return;
    o.info = { ...o.info, status, error };
    void o.fh.close().catch(() => {});
    this.history.unshift(o.info);
    this.history = this.history.slice(0, 20);
    this.d.onChange();
  }

  private set(o: Out, patch: Partial<Transfer>) { o.info = { ...o.info, ...patch }; this.d.onChange(); }

  private check() {
    for (const o of [...this.out.values()]) {
      if (this.now() - o.lastAt > this.idleMs) {
        this.d.send(o.info.to, "file.cancel", { transferId: o.info.id });
        this.finish(o, "failed", `No answer from ${o.info.toName}. Make sure Solo is running on it, then try again.`);
      }
    }
  }

  /** Feed every message from a paired device. Returns true if it was a file message for one of our transfers. */
  handle(from: string, env: Envelope): boolean {
    if (!env.type.startsWith("file.")) return false;
    const p = env.payload as { transferId?: string; ok?: boolean; reason?: string; seq?: number };
    const o = p.transferId ? this.out.get(p.transferId) : undefined;
    if (!o || o.info.to !== from) return false;
    o.lastAt = this.now();
    switch (env.type) {
      case "file.reply":
        if (p.ok) { this.set(o, { status: "sending" }); void this.pump(o); }
        else this.finish(o, "failed", p.reason ?? `${o.info.toName} refused the file.`);
        break;
      case "file.ack": o.acked = Math.max(o.acked, (p.seq ?? 0) + 1); void this.pump(o); break;
      case "file.result":
        if (p.ok) { this.set(o, { sent: o.info.size }); this.finish(o, "done"); }
        else this.finish(o, "failed", p.reason ?? "The file did not arrive correctly.");
        break;
      case "file.cancel": this.finish(o, "failed", p.reason ?? `${o.info.toName} cancelled the transfer.`); break;
      default: return false;
    }
    return true;
  }

  private async pump(o: Out) {
    if (o.pumping || !this.out.has(o.info.id)) return;
    o.pumping = true;
    try {
      while (this.out.has(o.info.id) && !o.eof && o.nextSeq - o.acked < FILE_WINDOW) {
        const buf = Buffer.alloc(FILE_CHUNK_BYTES);
        const { bytesRead } = await o.fh.read(buf, 0, FILE_CHUNK_BYTES, o.offset);
        if (!this.out.has(o.info.id)) return;
        if (bytesRead === 0) { o.eof = true; break; }
        const chunk = buf.subarray(0, bytesRead);
        o.hash.update(chunk);
        o.offset += bytesRead;
        const seq = o.nextSeq++;
        if (!this.d.send(o.info.to, "file.chunk", { transferId: o.info.id, seq, data: chunk.toString("base64") })) {
          this.finish(o, "failed", `${o.info.toName} went offline. Send the file again when it is back.`);
          return;
        }
        this.set(o, { sent: Math.min(o.offset, o.info.size) });
      }
      if (this.out.has(o.info.id) && o.eof && !o.endSent && o.acked >= o.nextSeq) {
        o.endSent = true;
        this.set(o, { status: "finishing" });
        if (!this.d.send(o.info.to, "file.end", { transferId: o.info.id, sha256: o.hash.digest("hex") })) this.finish(o, "failed", `${o.info.toName} went offline before confirming.`);
      }
    } catch (e) {
      if (this.out.has(o.info.id)) this.finish(o, "failed", `Could not read the file: ${e instanceof Error ? e.message : String(e)}`);
    } finally { o.pumping = false; }
  }
}
