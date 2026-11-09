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

/**
 * Sending a file from one Solo device to another over the encrypted link (LAN or relay). Flow:
 *   sender: file.offer {transferId, name, size}  ->  receiver: file.reply {ok}
 *   sender: file.chunk {seq, data} ... (a window of FILE_WINDOW chunks in flight)  <-  receiver: file.ack {seq}
 *   sender: file.end {sha256}  ->  receiver verifies size and hash, then file.result {ok}
 * Either side may send file.cancel. Chunks must arrive in order; the receiver cancels on a gap.
 */
export const FILE_CHUNK_BYTES = 48 * 1024; // raw bytes per chunk (about 64 KB as base64, well under the relay's 256 KB frame limit)
export const FILE_WINDOW = 8;
export const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB per file
const transferId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

export const FileOffer = z.object({
  ...base,
  type: z.literal("file.offer"),
  payload: z.object({ transferId, name: z.string().min(1).max(300), size: z.number().int().min(0).max(MAX_FILE_BYTES) }),
});
export const FileReply = z.object({
  ...base,
  type: z.literal("file.reply"),
  payload: z.object({ transferId, ok: z.boolean(), reason: z.string().max(200).optional() }),
});
export const FileChunk = z.object({
  ...base,
  type: z.literal("file.chunk"),
  payload: z.object({ transferId, seq: z.number().int().min(0), data: z.string().max(FILE_CHUNK_BYTES * 2) }),
});
export const FileAck = z.object({
  ...base,
  type: z.literal("file.ack"),
  payload: z.object({ transferId, seq: z.number().int().min(0) }),
});
export const FileEnd = z.object({
  ...base,
  type: z.literal("file.end"),
  payload: z.object({ transferId, sha256: z.string().regex(/^[0-9a-f]{64}$/) }),
});
export const FileResult = z.object({
  ...base,
  type: z.literal("file.result"),
  payload: z.object({ transferId, ok: z.boolean(), reason: z.string().max(200).optional() }),
});
export const FileCancel = z.object({
  ...base,
  type: z.literal("file.cancel"),
  payload: z.object({ transferId, reason: z.string().max(200).optional() }),
});

export const Envelope = z.discriminatedUnion("type", [
  FileOffer,
  FileReply,
  FileChunk,
  FileAck,
  FileEnd,
  FileResult,
  FileCancel,
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
