import { EventEmitter } from "node:events";
import { randomUUID, randomBytes } from "node:crypto";
import WebSocket from "ws";
import {
  Session, hsFinish, hsInitiate, hsRespond, idOf, pairingProof, randomNonce, rendezvousKey, newPairingCode,
  normalizeCode, safeEqual, signText, type HsState, type Identity,
} from "@solo/crypto";
import {
  PROTOCOL_VERSION, PeerBody, RelayToDevice, parseEnvelope, relayAuthText, type DeviceInfo, type Envelope,
} from "@solo/shared";
import type { DeviceStore } from "../link/store";

export type RelayStatus = "off" | "connecting" | "online";

export interface RelayEvents {
  connected: [DeviceInfo];
  disconnected: [string];
  message: [string, Envelope];
  paired: [DeviceInfo];
  status: [RelayStatus];
}

interface PeerState {
  session?: Session;
  pending?: HsState;
  queue: { at: number; frame: string }[];
  lastResetSent: number;
}

const PAIR_TTL_MS = 120_000;
const PAIR_MAX_ATTEMPTS = 5;
const QUEUE_MAX = 64;
const QUEUE_TTL_MS = 30_000;

/** ws:// is only allowed to loopback/private hosts (tests, home server). Everything else must be wss://. */
export function validRelayUrl(u: string): boolean {
  try {
    const url = new URL(u);
    if (url.protocol === "wss:") return true;
    if (url.protocol !== "ws:") return false;
    return /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname);
  } catch { return false; }
}

/**
 * Internet transport. Connects OUT to the relay (works on mobile data and behind any NAT), authenticates with this
 * device's key, and keeps an end-to-end encrypted session with each paired device that is online. Exposes the same
 * surface as the LAN LinkServer (connected/disconnected/message events, send, onlineDeviceIds) so sync and the rest of
 * the app do not care which path a message takes.
 */
export class RelayClient extends EventEmitter<RelayEvents> {
  private ws?: WebSocket;
  private url?: string;
  private _status: RelayStatus = "off";
  private backoff = 1000;
  private retry?: NodeJS.Timeout;
  private stopped = true;
  private peers = new Map<string, PeerState>();
  private onlinePeers = new Set<string>();
  private hosting?: { code: string; key: string; expires: number; attempts: number };
  private joining?: {
    code: string; nonce: string; hostId?: string; done: (r: { ok: true; device: DeviceInfo } | { ok: false; error: string }) => void; timer: NodeJS.Timeout;
  };

  constructor(private o: { identity: Identity; self: () => DeviceInfo; store: DeviceStore; now?: () => number }) { super(); }

  private now() { return (this.o.now ?? Date.now)(); }
  get status() { return this._status; }
  get relayUrl() { return this.url; }
  get onlineDeviceIds(): string[] { return [...this.peers.entries()].filter(([, p]) => p.session).map(([id]) => id); }
  get pairing() { return this.hosting && this.hosting.expires > this.now() ? { code: this.hosting.code, expiresAt: this.hosting.expires } : undefined; }

  private setStatus(s: RelayStatus) { if (s !== this._status) { this._status = s; this.emit("status", s); } }

  // ---- connection ---------------------------------------------------------------------------------------

  /** Set (or clear) the relay address. Reconnects as needed. */
  setUrl(url?: string) {
    if (url === this.url && !this.stopped) return;
    this.url = url && validRelayUrl(url) ? url : undefined;
    this.teardown();
    this.stopped = !this.url;
    if (this.url) this.connect(); else this.setStatus("off");
  }

  stop() { this.stopped = true; this.teardown(); this.setStatus("off"); }

  private teardown() {
    clearTimeout(this.retry);
    const ws = this.ws; this.ws = undefined;
    ws?.removeAllListeners(); ws?.on("error", () => {}); ws?.terminate();
    this.dropAllSessions();
    this.onlinePeers.clear();
  }

  private dropAllSessions() {
    for (const [id, p] of this.peers) { if (p.session) this.emit("disconnected", id); p.session = undefined; p.pending = undefined; }
  }

  private connect() {
    if (!this.url || this.stopped) return;
    this.setStatus("connecting");
    const ws = new WebSocket(this.url, { handshakeTimeout: 10_000, maxPayload: 512 * 1024 });
    this.ws = ws;
    ws.on("message", (d) => {
      if (this.ws !== ws) return;
      let m; try { m = RelayToDevice.safeParse(JSON.parse(d.toString())); } catch { return; }
      if (m.success) this.onRelay(m.data);
    });
    const lost = () => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      this.dropAllSessions();
      this.onlinePeers.clear();
      this.setStatus(this.stopped ? "off" : "connecting");
      if (!this.stopped) { this.retry = setTimeout(() => this.connect(), this.backoff); this.backoff = Math.min(this.backoff * 2, 30_000); }
    };
    ws.on("close", lost);
    ws.on("error", () => { /* followed by close */ });
  }

  private tx(m: object) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m)); }

  private trusted(id: string) {
    const r = this.o.store.get(id);
    return r && !r.revoked && r.device.pub && idOf(r.device.pub) === id ? r : undefined;
  }

  // ---- relay frames -------------------------------------------------------------------------------------

  private onRelay(m: RelayToDevice) {
    switch (m.t) {
      case "hello":
        this.tx({ t: "auth", pub: this.o.identity.pub, sig: signText(this.o.identity, relayAuthText(m.nonce)) });
        return;
      case "ready":
        this.backoff = 1000;
        this.setStatus("online");
        this.watchPeers();
        if (this.hosting && this.hosting.expires > this.now()) this.tx({ t: "rdv.open", key: this.hosting.key });
        return;
      case "presence":
        if (m.online) { this.onlinePeers.add(m.id); this.ensureSession(m.id); } else this.peerGone(m.id);
        return;
      case "offline":
        this.peerGone(m.to);
        return;
      case "msg":
        this.onBody(m.from, m.body);
        return;
      case "rdv.found":
        if (this.joining) { this.joining.hostId = m.host; this.sendPairReq(m.host); }
        return;
      case "rdv.none":
        this.finishJoin({ ok: false, error: "Code not found or expired" });
        return;
      default:
        return; // rdv.opened, rdv.joined (informational), peers, error
    }
  }

  private watchPeers() {
    const ids = this.o.store.list().filter((d) => !d.revoked && d.device.pub).map((d) => d.device.deviceId);
    if (ids.length) this.tx({ t: "watch", ids });
  }

  /** Call after the paired-device list changes so presence is tracked for new peers. */
  refreshWatch() { if (this._status === "online") this.watchPeers(); }

  private peerGone(id: string) {
    this.onlinePeers.delete(id);
    const p = this.peers.get(id);
    if (p?.session) this.emit("disconnected", id);
    if (p) { p.session = undefined; p.pending = undefined; }
  }

  // ---- sessions -----------------------------------------------------------------------------------------

  private peer(id: string): PeerState {
    let p = this.peers.get(id);
    if (!p) { p = { queue: [], lastResetSent: 0 }; this.peers.set(id, p); }
    return p;
  }

  private body(to: string, b: object) { this.tx({ t: "send", to, body: JSON.stringify(b) }); }

  /** The device with the lower id always initiates, so two devices never handshake at the same time. */
  private ensureSession(id: string) {
    const rec = this.trusted(id);
    if (!rec || this._status !== "online") return;
    const p = this.peer(id);
    if (p.session || p.pending) return;
    if (this.o.identity.id < id) {
      const { msg, state } = hsInitiate(this.o.identity, id);
      p.pending = state;
      const self = this.o.self();
      this.body(id, { k: "hs1", ...msg, name: self.name, kind: self.kind });
    } else if (this.now() - p.lastResetSent > 3000) {
      p.lastResetSent = this.now();
      this.body(id, { k: "reset" }); // ask the lower-id side to start
    }
  }

  private established(id: string, session: Session) {
    const p = this.peer(id);
    p.session = session; p.pending = undefined;
    const rec = this.o.store.get(id)!;
    this.o.store.touch(id);
    this.emit("connected", rec.device);
    const q = p.queue.splice(0).filter((x) => this.now() - x.at < QUEUE_TTL_MS);
    for (const x of q) this.body(id, { k: "data", ...session.seal(x.frame) });
  }

  private onBody(from: string, raw: string) {
    let b; try { b = PeerBody.safeParse(JSON.parse(raw)); } catch { return; }
    if (!b.success) return;
    const m = b.data;

    // pairing messages come from not-yet-trusted devices
    if (m.k === "pair.req") return this.onPairReq(from, m);
    if (m.k === "pair.ack") return this.onPairAck(from, m);
    if (m.k === "pair.no") return this.finishJoin({ ok: false, error: m.reason === "bad_proof" ? "Wrong code" : m.reason === "locked" ? "Too many attempts. Start again on the other device" : "Code expired" });

    const rec = this.trusted(from);
    if (!rec) return; // strangers and revoked devices are ignored entirely
    const p = this.peer(from);

    switch (m.k) {
      case "hs1": {
        if (p.pending && this.o.identity.id < from) return; // we are the initiator; ignore their simultaneous attempt
        p.pending = undefined;
        const r = hsRespond(this.o.identity, from, rec.device.pub!, m);
        if (!r) return;
        const self = this.o.self();
        this.body(from, { k: "hs2", ...r.msg, name: self.name, kind: self.kind });
        this.o.store.setReportedName(from, m.name || rec.device.name);
        if (p.session) this.emit("disconnected", from);
        this.established(from, r.session);
        return;
      }
      case "hs2": {
        if (!p.pending) return;
        const s = hsFinish(this.o.identity, from, rec.device.pub!, p.pending, m);
        if (!s) { p.pending = undefined; return; }
        this.o.store.setReportedName(from, m.name || rec.device.name);
        this.established(from, s);
        return;
      }
      case "reset":
        // A handshake already in flight will finish on its own; restarting it would orphan the peer's reply.
        if (p.pending) return;
        if (p.session) { p.session = undefined; this.emit("disconnected", from); }
        this.ensureSession(from);
        return;
      case "data": {
        const pt = p.session?.open(m);
        if (pt == null) {
          if (this.now() - p.lastResetSent > 3000) { p.lastResetSent = this.now(); this.body(from, { k: "reset" }); }
          return;
        }
        let env: Envelope | null = null;
        try { env = parseEnvelope(JSON.parse(pt)); } catch { /* ignore */ }
        if (env && env.from === from) this.emit("message", from, env);
        return;
      }
    }
  }

  /** Same surface as LinkServer.send. Returns false only if the peer is unknown or revoked. */
  send(to: string, type: Envelope["type"], payload: unknown): boolean {
    if (!this.trusted(to) || this._status !== "online") return false;
    const frame = JSON.stringify({ v: PROTOCOL_VERSION, id: randomUUID(), ts: Date.now(), from: this.o.identity.id, type, payload });
    const p = this.peer(to);
    if (p.session) { this.body(to, { k: "data", ...p.session.seal(frame) }); return true; }
    if (!this.onlinePeers.has(to)) return false; // nobody to deliver to; sync resends everything on the next connect
    if (p.queue.length < QUEUE_MAX) p.queue.push({ at: this.now(), frame });
    this.ensureSession(to);
    return true;
  }

  // ---- pairing by code ----------------------------------------------------------------------------------

  /** Host side: show this code on screen; the other device enters it. */
  hostPairing(): { code: string; expiresAt: number } {
    const code = newPairingCode();
    this.hosting = { code, key: rendezvousKey(code), expires: this.now() + PAIR_TTL_MS, attempts: 0 };
    this.tx({ t: "rdv.open", key: this.hosting.key });
    return { code, expiresAt: this.hosting.expires };
  }

  cancelPairing() {
    if (this.hosting) this.tx({ t: "rdv.close" });
    this.hosting = undefined;
  }

  private selfBrief() { const s = this.o.self(); return { name: s.name, kind: s.kind, appVersion: s.appVersion }; }

  private onPairReq(from: string, m: Extract<PeerBody, { k: "pair.req" }>) {
    const h = this.hosting;
    if (!h || h.expires <= this.now()) return this.body(from, { k: "pair.no", reason: "expired" });
    if (h.attempts >= PAIR_MAX_ATTEMPTS) return this.body(from, { k: "pair.no", reason: "locked" });
    const mine = this.o.identity;
    const expect = pairingProof(h.code, "req", mine.id, from, m.nonce, m.pub, ""); // host key is bound via the host id in the message
    if (idOf(m.pub) !== from || !safeEqual(expect, m.proof)) {
      h.attempts++;
      if (h.attempts >= PAIR_MAX_ATTEMPTS) this.cancelPairing();
      return this.body(from, { k: "pair.no", reason: "bad_proof" });
    }
    const device: DeviceInfo = { deviceId: from, kind: m.device.kind, name: m.device.name, appVersion: m.device.appVersion, pub: m.pub };
    this.o.store.add(device, randomBytes(32).toString("hex"));
    this.hosting = undefined;
    this.tx({ t: "rdv.close" });
    this.body(from, { k: "pair.ack", device: this.selfBrief(), pub: mine.pub, proof: pairingProof(h.code, "ack", mine.id, from, m.nonce, m.pub, mine.pub) });
    this.refreshWatch();
    this.emit("paired", device);
    this.ensureSession(from);
  }

  /** Joiner side: enter the code shown on the other device. */
  joinPairing(codeInput: string): Promise<{ ok: true; device: DeviceInfo } | { ok: false; error: string }> {
    if (this._status !== "online") return Promise.resolve({ ok: false, error: "Not connected to the relay" });
    const code = normalizeCode(codeInput);
    if (code.length !== 12) return Promise.resolve({ ok: false, error: "Enter the 12-character code" });
    this.finishJoin({ ok: false, error: "Cancelled" });
    return new Promise((done) => {
      const timer = setTimeout(() => this.finishJoin({ ok: false, error: "No answer from the other device" }), 20_000);
      this.joining = { code, nonce: randomNonce(), done, timer };
      this.tx({ t: "rdv.join", key: rendezvousKey(code) });
    });
  }

  private finishJoin(r: { ok: true; device: DeviceInfo } | { ok: false; error: string }) {
    const j = this.joining; if (!j) return;
    this.joining = undefined; clearTimeout(j.timer); j.done(r);
  }

  private sendPairReq(host: string) {
    const j = this.joining; if (!j) return;
    const mine = this.o.identity;
    this.body(host, {
      k: "pair.req", device: this.selfBrief(), pub: mine.pub, nonce: j.nonce,
      proof: pairingProof(j.code, "req", host, mine.id, j.nonce, mine.pub, "" /* host key unknown yet */),
    });
  }

  private onPairAck(from: string, m: Extract<PeerBody, { k: "pair.ack" }>) {
    const j = this.joining;
    if (!j || j.hostId !== from) return;
    const mine = this.o.identity;
    const expect = pairingProof(j.code, "ack", from, mine.id, j.nonce, mine.pub, m.pub);
    if (idOf(m.pub) !== from || !safeEqual(expect, m.proof)) return this.finishJoin({ ok: false, error: "The other device did not prove it knows the code" });
    const device: DeviceInfo = { deviceId: from, kind: m.device.kind, name: m.device.name, appVersion: m.device.appVersion, pub: m.pub };
    this.o.store.add(device, randomBytes(32).toString("hex"));
    this.refreshWatch();
    this.finishJoin({ ok: true, device });
    this.emit("paired", device);
    this.ensureSession(from);
  }
}
