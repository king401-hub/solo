import { createServer, type Server } from "node:https";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { PROTOCOL_VERSION, parseEnvelope, type DeviceInfo, type Envelope } from "@solo/shared";
import type { LinkCert } from "./cert";
import { PairingSession, authProof, newNonce, newToken, safeEqualHex } from "./pairing";
import type { DeviceStore } from "./store";

type Reject = Extract<Envelope, { type: "pair.reject" }>["payload"]["reason"];
const HANDSHAKE_TIMEOUT_MS = 10_000;
const HEARTBEAT_TIMEOUT_MS = 45_000;

export interface LinkEvents {
  connected: [DeviceInfo];
  disconnected: [string];
  paired: [DeviceInfo];
  message: [string, Envelope];
}

/** Desktop side of the LAN link: wss server, pairing + token auth, live-session registry. */
export class LinkServer extends EventEmitter<LinkEvents> {
  private http?: Server;
  private wss?: WebSocketServer;
  private sessions = new Map<string, WebSocket>();
  private pairing?: PairingSession;

  constructor(private opts: { self: DeviceInfo; cert: LinkCert; store: DeviceStore }) { super(); }

  get certSha256() { return this.opts.cert.sha256; }
  get onlineDeviceIds() { return [...this.sessions.keys()]; }

  async listen(port = 0, host = "0.0.0.0"): Promise<number> {
    this.http = createServer({ cert: this.opts.cert.cert, key: this.opts.cert.key });
    this.wss = new WebSocketServer({ server: this.http, maxPayload: 1 << 20 });
    this.wss.on("connection", (ws) => this.onConnection(ws));
    await new Promise<void>((res) => this.http!.listen(port, host, res));
    const addr = this.http.address();
    return typeof addr === "object" && addr ? addr.port : port;
  }

  async close() {
    for (const ws of this.wss?.clients ?? []) ws.terminate();
    this.wss?.close();
    await new Promise<void>((res) => (this.http ? this.http.close(() => res()) : res()));
  }

  /** Begin (or restart) a pairing window. Returns the code to show on screen. */
  startPairing(): { code: string; expiresAt: number } {
    this.pairing = new PairingSession();
    return { code: this.pairing.code, expiresAt: this.pairing.expiresAt };
  }
  cancelPairing() { this.pairing = undefined; }

  disconnect(deviceId: string) { this.sessions.get(deviceId)?.close(4001, "revoked"); }

  send(deviceId: string, type: Envelope["type"], payload: unknown): boolean {
    const ws = this.sessions.get(deviceId);
    if (!ws || ws.readyState !== ws.OPEN) return false;
    ws.send(JSON.stringify(this.frame(type, payload)));
    return true;
  }

  private frame(type: string, payload: unknown) {
    return { v: PROTOCOL_VERSION, id: randomUUID(), ts: Date.now(), from: this.opts.self.deviceId, type, payload };
  }

  private onConnection(ws: WebSocket) {
    const nonce = newNonce();
    let deviceId: string | undefined;
    const reply = (type: string, payload: unknown) => ws.send(JSON.stringify(this.frame(type, payload)));
    const reject = (reason: Reject) => { reply("pair.reject", { reason }); ws.close(4000, reason); };
    const hsTimer = setTimeout(() => { if (!deviceId) ws.terminate(); }, HANDSHAKE_TIMEOUT_MS);
    let alive = Date.now();
    const hb = setInterval(() => { if (Date.now() - alive > HEARTBEAT_TIMEOUT_MS) ws.terminate(); }, 10_000);

    reply("auth.challenge", { nonce, device: this.opts.self });

    ws.on("message", (data) => {
      let raw: unknown;
      try { raw = JSON.parse(data.toString()); } catch { return ws.terminate(); }
      const env = parseEnvelope(raw);
      if (!env) return; // drop invalid frames silently
      alive = Date.now();

      if (!deviceId) {
        if (env.type === "pair.request") {
          const { device, pairingCodeProof } = env.payload;
          if (device.deviceId !== env.from) return reject("bad_proof");
          if (!this.pairing) return reject("expired");
          const r = this.pairing.verify(pairingCodeProof, nonce, device.deviceId, this.opts.cert.sha256);
          if (r !== "ok") return reject(r);
          this.pairing = undefined;
          const token = newToken();
          this.opts.store.add(device, token);
          reply("pair.accept", { device: this.opts.self, authToken: token });
          this.emit("paired", device);
          return this.register(ws, device, () => (deviceId = device.deviceId), hsTimer, hb);
        }
        if (env.type === "auth.hello") {
          const { device, proof } = env.payload;
          if (device.deviceId !== env.from) return reject("bad_proof");
          const known = this.opts.store.get(device.deviceId);
          if (!known) return reject("unknown_device");
          if (known.revoked) return reject("revoked");
          if (!safeEqualHex(proof, authProof(known.token, nonce, device.deviceId))) return reject("bad_proof");
          this.opts.store.touch(device.deviceId);
          reply("auth.ok", { device: this.opts.self });
          return this.register(ws, device, () => (deviceId = device.deviceId), hsTimer, hb);
        }
        return; // nothing else is accepted before authentication
      }
      if (env.from !== deviceId) return; // no spoofing another device on an authed socket
      if (env.type === "heartbeat") return;
      this.emit("message", deviceId, env);
    });

    ws.on("close", () => {
      clearTimeout(hsTimer); clearInterval(hb);
      if (deviceId && this.sessions.get(deviceId) === ws) { this.sessions.delete(deviceId); this.emit("disconnected", deviceId); }
    });
    ws.on("error", () => ws.terminate());
  }

  private register(ws: WebSocket, device: DeviceInfo, setId: () => void, hsTimer: NodeJS.Timeout, _hb: NodeJS.Timeout) {
    clearTimeout(hsTimer);
    setId();
    this.sessions.get(device.deviceId)?.close(4002, "replaced");
    this.sessions.set(device.deviceId, ws);
    this.emit("connected", device);
  }
}
