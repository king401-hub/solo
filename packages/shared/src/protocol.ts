import { z } from "zod";

/** Protocol version; bump on breaking wire changes. Devices refuse to talk across major versions. */
export const PROTOCOL_VERSION = 1;

export const DeviceKind = z.enum(["windows", "android"]);
export type DeviceKind = z.infer<typeof DeviceKind>;

export const DeviceInfo = z.object({
  deviceId: z.string().min(8),
  kind: DeviceKind,
  name: z.string().min(1).max(80),
  appVersion: z.string(),
  /** Ed25519 public key (base64url). deviceId === SHA-256(pub) hex, so an id cannot be claimed without the key. */
  pub: z.string().min(40).max(48).optional(),
});
export type DeviceInfo = z.infer<typeof DeviceInfo>;

/** Every message on the WebSocket link is an Envelope. */
const base = {
  v: z.literal(PROTOCOL_VERSION),
  id: z.string().min(1), // unique per message, for dedupe/ack
  ts: z.number().int().nonnegative(), // sender epoch ms
  from: z.string().min(1), // sender deviceId
};

/**
 * Link handshake (see docs/SECURITY.md "Pairing"):
 *  1. Client opens wss:// to the desktop. Desktop sends `auth.challenge` with a fresh nonce.
 *  2. First time: client sends `pair.request` with proof = HMAC-SHA256(key=utf8(code),
 *     msg="solo-pair-v1|nonce|deviceId|certSha256")  (hex). certSha256 is the TLS cert fingerprint
 *     the client actually observed, so a man-in-the-middle cannot produce a valid proof.
 *     Desktop replies `pair.accept` with a long-term `authToken`, or `pair.reject`.
 *  3. Later: client sends `auth.hello` with proof = HMAC-SHA256(key=utf8(authToken),
 *     msg="solo-auth-v1|nonce|deviceId") (hex). Desktop replies `auth.ok` or `pair.reject`.
 */
export const AuthChallenge = z.object({
  ...base,
  type: z.literal("auth.challenge"),
  payload: z.object({ nonce: z.string().min(16), device: DeviceInfo }),
});

export const PairRequest = z.object({
  ...base,
  type: z.literal("pair.request"),
  payload: z.object({ device: DeviceInfo, pairingCodeProof: z.string() }),
});

/**
 * Code-free pairing ("pair.ask"): client asks to be paired; the desktop user approves (or auto-approves if they
 * enabled it). Both screens can show sas = first 4 digits of SHA-256("solo-sas-v1|nonce|certSha256") so the user can
 * confirm the phone and PC saw the same certificate. Only accepted from private-network addresses.
 */
export const PairAsk = z.object({
  ...base,
  type: z.literal("pair.ask"),
  payload: z.object({ device: DeviceInfo }),
});

/** Authenticated device renames itself; desktop updates its label. */
export const DeviceRename = z.object({
  ...base,
  type: z.literal("device.rename"),
  payload: z.object({ name: z.string().min(1).max(80) }),
});

export const PairAccept = z.object({
  ...base,
  type: z.literal("pair.accept"),
  payload: z.object({ device: DeviceInfo, authToken: z.string().min(32) }),
});

export const AuthHello = z.object({
  ...base,
  type: z.literal("auth.hello"),
  payload: z.object({ device: DeviceInfo, proof: z.string() }),
});

export const AuthOk = z.object({
  ...base,
  type: z.literal("auth.ok"),
  payload: z.object({ device: DeviceInfo }),
});

export const PairReject = z.object({
  ...base,
  type: z.literal("pair.reject"),
  payload: z.object({ reason: z.enum(["bad_proof", "expired", "locked", "unknown_device", "revoked", "version", "denied", "busy", "forbidden"]) }),
});

export const Heartbeat = z.object({
  ...base,
  type: z.literal("heartbeat"),
  payload: z.object({ battery: z.number().min(0).max(100).optional() }),
});

export const NotificationSync = z.object({
  ...base,
  type: z.literal("notification.sync"),
  payload: z.object({
    key: z.string(),
    app: z.string(),
    sender: z.string().optional(),
    text: z.string().optional(),
    canReply: z.boolean(),
    posted: z.number().int(),
    removed: z.boolean().default(false),
  }),
});

export const TaskDispatch = z.object({
  ...base,
  type: z.literal("task.dispatch"),
  payload: z.object({ taskId: z.string() }),
});

export const TaskUpdate = z.object({
  ...base,
  type: z.literal("task.update"),
  payload: z.object({
    taskId: z.string(),
    status: z.enum(["queued", "awaiting_confirmation", "running", "done", "failed", "cancelled"]),
    note: z.string().optional(),
  }),
});

export const SyncDeltaMsg = z.object({
  ...base,
  type: z.literal("sync.delta"),
  payload: z.object({
    table: z.enum(["memories", "tasks", "conversations", "settings"]),
    rowId: z.string(),
    updatedAt: z.number().int(), // last-writer-wins by (updatedAt, by); see sync.ts
    by: z.string().min(1), // device that originally wrote the row (not necessarily the sender)
    deleted: z.boolean().default(false),
    data: z.record(z.unknown()).optional(),
  }),
});

/**
 * File sync (Syncthing) identity exchange. Sent between already-trusted Solo devices over the encrypted link so they can
 * add each other as sync devices without the user copying long ids around. It only introduces the device; sharing any
 * folder still requires an explicit action by the user on both sides.
 */
export const SYNCTHING_ID = /^[A-Z2-7]{7}(-[A-Z2-7]{7}){7}$/;
export const FilesDevice = z.object({
  ...base,
  type: z.literal("files.device"),
  payload: z.object({ syncthingId: z.string().regex(SYNCTHING_ID), name: z.string().min(1).max(80) }),
});

export const Envelope = z.discriminatedUnion("type", [
  AuthChallenge,
  PairRequest,
  PairAsk,
  DeviceRename,
  PairAccept,
  AuthHello,
  AuthOk,
  PairReject,
  Heartbeat,
  NotificationSync,
  TaskDispatch,
  TaskUpdate,
  SyncDeltaMsg,
  FilesDevice,
]);
export type Envelope = z.infer<typeof Envelope>;

/** Parse untrusted wire data. Returns null on any violation; never throws. */
export function parseEnvelope(raw: unknown): Envelope | null {
  const r = Envelope.safeParse(raw);
  return r.success ? r.data : null;
}
