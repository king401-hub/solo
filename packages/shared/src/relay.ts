import { z } from "zod";

/**
 * Wire protocol between a device and the Solo relay (cloud hub). The relay authenticates a device by its Ed25519 key,
 * then forwards opaque, end-to-end encrypted bodies by device id. It never sees message contents.
 * Devices are identified by id = SHA-256(public key), so there are no accounts and nothing to register.
 */
export const RELAY_VERSION = 1;
export const MAX_RELAY_BODY = 256 * 1024;

const id = z.string().regex(/^[0-9a-f]{64}$/);

// relay -> device
export const RelayHello = z.object({ t: z.literal("hello"), nonce: z.string().min(16), v: z.number().int() });
export const RelayReady = z.object({ t: z.literal("ready"), id });
export const RelayMsg = z.object({ t: z.literal("msg"), from: id, body: z.string().max(MAX_RELAY_BODY) });
export const RelayOffline = z.object({ t: z.literal("offline"), to: id });
export const RelayPeers = z.object({ t: z.literal("peers"), online: z.array(id) });
export const RelayPresence = z.object({ t: z.literal("presence"), id, online: z.boolean() });
export const RdvOpened = z.object({ t: z.literal("rdv.opened") });
export const RdvFound = z.object({ t: z.literal("rdv.found"), host: id });
export const RdvNone = z.object({ t: z.literal("rdv.none") });
export const RdvJoined = z.object({ t: z.literal("rdv.joined"), joiner: id });
export const RelayError = z.object({ t: z.literal("error"), code: z.enum(["rate", "bad_frame", "too_large"]) });

export const RelayToDevice = z.discriminatedUnion("t", [
  RelayHello, RelayReady, RelayMsg, RelayOffline, RelayPeers, RelayPresence, RdvOpened, RdvFound, RdvNone, RdvJoined, RelayError,
]);
export type RelayToDevice = z.infer<typeof RelayToDevice>;

// device -> relay
export const RelayAuth = z.object({ t: z.literal("auth"), pub: z.string().min(40).max(48), sig: z.string().min(80).max(100) });
export const RelaySend = z.object({ t: z.literal("send"), to: id, body: z.string().max(MAX_RELAY_BODY) });
export const RelayPeersReq = z.object({ t: z.literal("peers"), ids: z.array(id).max(64) });
export const RelayWatch = z.object({ t: z.literal("watch"), ids: z.array(id).max(64) });
export const RdvOpen = z.object({ t: z.literal("rdv.open"), key: z.string().regex(/^[0-9a-f]{32}$/) });
export const RdvJoin = z.object({ t: z.literal("rdv.join"), key: z.string().regex(/^[0-9a-f]{32}$/) });
export const RdvClose = z.object({ t: z.literal("rdv.close") });

export const DeviceToRelay = z.discriminatedUnion("t", [RelayAuth, RelaySend, RelayPeersReq, RelayWatch, RdvOpen, RdvJoin, RdvClose]);
export type DeviceToRelay = z.infer<typeof DeviceToRelay>;

/** The text a device signs to authenticate to a relay: binds the relay's fresh nonce. */
export const relayAuthText = (nonce: string) => `solo-relay-v1|${nonce}`;

// ---- Messages carried INSIDE the relay "body" (devices only; the relay never parses these) ----

/** Pre-trust pairing messages, authenticated by the one-time code (HMAC proofs from @solo/crypto). */
export const RemotePairReq = z.object({
  k: z.literal("pair.req"),
  device: z.object({ name: z.string().min(1).max(80), kind: z.enum(["windows", "android"]), appVersion: z.string() }),
  pub: z.string(),
  nonce: z.string(),
  proof: z.string(),
});
export const RemotePairAck = z.object({
  k: z.literal("pair.ack"),
  device: z.object({ name: z.string().min(1).max(80), kind: z.enum(["windows", "android"]), appVersion: z.string() }),
  pub: z.string(),
  proof: z.string(),
});
export const RemotePairNo = z.object({ k: z.literal("pair.no"), reason: z.enum(["bad_proof", "expired", "locked"]) });

/** Session handshake and encrypted data between already-trusted devices. */
export const SessionHs1 = z.object({ k: z.literal("hs1"), eph: z.string(), n: z.string(), sig: z.string(), name: z.string().max(80), kind: z.enum(["windows", "android"]) });
export const SessionHs2 = z.object({ k: z.literal("hs2"), eph: z.string(), sig: z.string(), name: z.string().max(80), kind: z.enum(["windows", "android"]) });
export const SessionData = z.object({ k: z.literal("data"), c: z.number().int().nonnegative(), ct: z.string() });
export const SessionReset = z.object({ k: z.literal("reset") }); // "I lost our session; start a new handshake"

export const PeerBody = z.discriminatedUnion("k", [RemotePairReq, RemotePairAck, RemotePairNo, SessionHs1, SessionHs2, SessionData, SessionReset]);
export type PeerBody = z.infer<typeof PeerBody>;
