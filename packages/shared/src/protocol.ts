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
});
export type DeviceInfo = z.infer<typeof DeviceInfo>;

/** Every message on the WebSocket link is an Envelope. */
const base = {
  v: z.literal(PROTOCOL_VERSION),
  id: z.string().min(1), // unique per message, for dedupe/ack
  ts: z.number().int().nonnegative(), // sender epoch ms
  from: z.string().min(1), // sender deviceId
};

export const PairRequest = z.object({
  ...base,
  type: z.literal("pair.request"),
  payload: z.object({
    device: DeviceInfo,
    publicKey: z.string(), // base64 X25519/Ed25519 public key
    pairingCodeProof: z.string(), // HMAC over the short code shown on the other device
  }),
});

export const PairAccept = z.object({
  ...base,
  type: z.literal("pair.accept"),
  payload: z.object({ device: DeviceInfo, publicKey: z.string() }),
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

export const SyncDelta = z.object({
  ...base,
  type: z.literal("sync.delta"),
  payload: z.object({
    table: z.enum(["memories", "tasks", "conversations", "settings"]),
    rowId: z.string(),
    updatedAt: z.number().int(), // last-writer-wins by (updatedAt, deviceId)
    deleted: z.boolean().default(false),
    data: z.record(z.unknown()).optional(),
  }),
});

export const Envelope = z.discriminatedUnion("type", [
  PairRequest,
  PairAccept,
  Heartbeat,
  NotificationSync,
  TaskDispatch,
  TaskUpdate,
  SyncDelta,
]);
export type Envelope = z.infer<typeof Envelope>;

/** Parse untrusted wire data. Returns null on any violation; never throws. */
export function parseEnvelope(raw: unknown): Envelope | null {
  const r = Envelope.safeParse(raw);
  return r.success ? r.data : null;
}
