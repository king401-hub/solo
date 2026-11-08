import { createServer, type Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { DeviceToRelay, MAX_RELAY_BODY, RELAY_VERSION, relayAuthText, type RelayToDevice } from "@solo/shared";
import { idOf, randomNonce, verifyText } from "@solo/crypto";

export interface RelayOptions {
  port?: number;
  host?: string;
  /** Behind Fly/Render/etc. the real client address is in X-Forwarded-For. Only enable when a trusted proxy sets it. */
  trustProxy?: boolean;
  maxConnectionsPerIp?: number;
  /** Frames per second a single connection may send (burst = 2x). */
  ratePerSec?: number;
  rdvTtlMs?: number;
  /** Failed rendezvous joins per IP before it is blocked for blockMs. */
  maxFailedJoins?: number;
  blockMs?: number;
  authTimeoutMs?: number;
  pingMs?: number;
  now?: () => number;
}

interface Client {
  ws: WebSocket;
  id?: string;
  ip: string;
  watching: Set<string>;
  tokens: number;
  lastRefill: number;
  alive: boolean;
}

/**
 * The Solo relay: a deliberately dumb hub. It proves a device owns its id (Ed25519 signature over a fresh nonce),
 * then forwards opaque encrypted bodies to the addressed device. It keeps no accounts, stores no messages, and keeps
 * only in-memory state: who is online, who watches whom, and short-lived pairing rendezvous.
 */
export function createRelay(opts: RelayOptions = {}) {
  const o = {
    trustProxy: false, maxConnectionsPerIp: 20, ratePerSec: 50, rdvTtlMs: 120_000, maxFailedJoins: 10,
    blockMs: 10 * 60_000, authTimeoutMs: 10_000, pingMs: 25_000, now: Date.now, ...opts,
  };
  const clients = new Map<string, Client>(); // by device id
  const watchers = new Map<string, Set<string>>(); // target id -> watcher ids
  const rdv = new Map<string, { host: string; expires: number }>();
  const ipCount = new Map<string, number>();
  const failedJoins = new Map<string, { n: number; blockedUntil: number }>();
  const stats = { connections: 0, frames: 0 };

  const http: Server = createServer((req, res) => {
    if (req.url === "/healthz") { res.writeHead(200, { "content-type": "text/plain" }); res.end("ok"); return; }
    res.writeHead(404); res.end();
  });
  const wss = new WebSocketServer({ server: http, maxPayload: MAX_RELAY_BODY + 2048 });

  const send = (ws: WebSocket, m: RelayToDevice) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)); };
  const ipOf = (req: { socket: { remoteAddress?: string }; headers: Record<string, string | string[] | undefined> }) => {
    if (o.trustProxy) {
      const xf = req.headers["x-forwarded-for"];
      const first = (Array.isArray(xf) ? xf[0] : xf)?.split(",")[0]?.trim();
      if (first) return first;
    }
    return req.socket.remoteAddress ?? "unknown";
  };

  function notifyPresence(id: string, online: boolean) {
    for (const w of watchers.get(id) ?? []) {
      const c = clients.get(w);
      if (c) send(c.ws, { t: "presence", id, online });
    }
  }

  function setWatch(c: Client, ids: string[]) {
    for (const old of c.watching) watchers.get(old)?.delete(c.id!);
    c.watching = new Set(ids.filter((x) => x !== c.id));
    for (const t of c.watching) {
      (watchers.get(t) ?? watchers.set(t, new Set()).get(t)!).add(c.id!);
      if (clients.has(t)) send(c.ws, { t: "presence", id: t, online: true });
    }
  }

  function dropRdvOf(id: string) { for (const [k, v] of rdv) if (v.host === id) rdv.delete(k); }

  wss.on("connection", (ws, req) => {
    const ip = ipOf(req);
    const n = (ipCount.get(ip) ?? 0) + 1;
    if (n > o.maxConnectionsPerIp) { ws.close(1013, "too many connections"); return; }
    ipCount.set(ip, n);
    stats.connections++;
    const c: Client = { ws, ip, watching: new Set(), tokens: o.ratePerSec * 2, lastRefill: o.now(), alive: true };
    const nonce = randomNonce();
    send(ws, { t: "hello", nonce, v: RELAY_VERSION });
    const authTimer = setTimeout(() => { if (!c.id) ws.close(4408, "auth timeout"); }, o.authTimeoutMs);

    ws.on("pong", () => { c.alive = true; });
    ws.on("message", (data, isBinary) => {
      if (isBinary) return ws.close(4400, "text only");
      // token bucket
      const t = o.now();
      c.tokens = Math.min(o.ratePerSec * 2, c.tokens + ((t - c.lastRefill) / 1000) * o.ratePerSec);
      c.lastRefill = t;
      if (c.tokens < 1) { send(ws, { t: "error", code: "rate" }); return; }
      c.tokens -= 1;
      stats.frames++;

      let raw: unknown;
      try { raw = JSON.parse(data.toString()); } catch { return send(ws, { t: "error", code: "bad_frame" }); }
      const f = DeviceToRelay.safeParse(raw);
      if (!f.success) return send(ws, { t: "error", code: "bad_frame" });
      const m = f.data;

      if (!c.id) {
        if (m.t !== "auth") return; // nothing but auth before authentication
        const id = idOf(m.pub);
        if (!verifyText(m.pub, relayAuthText(nonce), m.sig)) return ws.close(4401, "bad signature");
        clearTimeout(authTimer);
        c.id = id;
        const prev = clients.get(id);
        if (prev && prev.ws !== ws) prev.ws.close(4409, "replaced by a newer connection");
        clients.set(id, c);
        send(ws, { t: "ready", id });
        notifyPresence(id, true);
        return;
      }

      switch (m.t) {
        case "auth": return;
        case "send": {
          const dst = clients.get(m.to);
          if (!dst) return send(ws, { t: "offline", to: m.to });
          send(dst.ws, { t: "msg", from: c.id, body: m.body });
          return;
        }
        case "peers":
          return send(ws, { t: "peers", online: m.ids.filter((x) => clients.has(x)) });
        case "watch":
          return setWatch(c, m.ids);
        case "rdv.open": {
          dropRdvOf(c.id);
          rdv.set(m.key, { host: c.id, expires: o.now() + o.rdvTtlMs });
          return send(ws, { t: "rdv.opened" });
        }
        case "rdv.close":
          return dropRdvOf(c.id);
        case "rdv.join": {
          const fj = failedJoins.get(c.ip);
          if (fj && fj.blockedUntil > o.now()) return ws.close(4429, "blocked");
          const e = rdv.get(m.key);
          if (!e || e.expires < o.now() || !clients.has(e.host) || e.host === c.id) {
            const rec = fj && fj.blockedUntil <= o.now() && fj.n < o.maxFailedJoins ? fj : { n: 0, blockedUntil: 0 };
            rec.n++;
            if (rec.n >= o.maxFailedJoins) { rec.blockedUntil = o.now() + o.blockMs; rec.n = 0; }
            failedJoins.set(c.ip, rec);
            return send(ws, { t: "rdv.none" });
          }
          send(ws, { t: "rdv.found", host: e.host });
          send(clients.get(e.host)!.ws, { t: "rdv.joined", joiner: c.id });
          return;
        }
      }
    });

    ws.on("close", () => {
      clearTimeout(authTimer);
      ipCount.set(ip, Math.max(0, (ipCount.get(ip) ?? 1) - 1));
      if (c.id && clients.get(c.id) === c) {
        clients.delete(c.id);
        dropRdvOf(c.id);
        for (const old of c.watching) watchers.get(old)?.delete(c.id);
        notifyPresence(c.id, false);
      }
    });
    ws.on("error", () => ws.terminate());
  });

  // Mobile networks silently drop connections; ping so dead sockets are cleaned up and presence stays truthful.
  const pinger = setInterval(() => {
    for (const w of wss.clients) {
      const c = [...clients.values()].find((x) => x.ws === w);
      if (c && !c.alive) { w.terminate(); continue; }
      if (c) c.alive = false;
      w.ping();
    }
    for (const [k, v] of rdv) if (v.expires < o.now()) rdv.delete(k);
  }, o.pingMs);
  pinger.unref();

  return {
    listen: () => new Promise<number>((res) => http.listen(o.port ?? 0, o.host ?? "0.0.0.0", () => {
      const a = http.address(); res(typeof a === "object" && a ? a.port : (o.port ?? 0));
    })),
    close: async () => {
      clearInterval(pinger);
      for (const w of wss.clients) w.terminate();
      wss.close();
      await new Promise<void>((res) => http.close(() => res()));
    },
    stats: () => ({ ...stats, online: clients.size, rendezvous: rdv.size }),
  };
}
