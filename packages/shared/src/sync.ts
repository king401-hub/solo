/**
 * Last-writer-wins row sync shared by every device (same algorithm is mirrored in Dart:
 * apps/android/lib/sync/sync_store.dart; the vectors in sync.test.ts are repeated there).
 *
 * Each row carries (updatedAt, by). The higher updatedAt wins; equal timestamps are broken by the larger device id,
 * so every device converges to the same value regardless of arrival order. updatedAt comes from a hybrid clock:
 * max(wall clock, highest timestamp ever seen + 1), so a phone whose clock runs slow still overwrites older data it
 * has already seen instead of silently losing.
 */
export interface SyncRow {
  updatedAt: number;
  by: string;
  deleted: boolean;
  data?: Record<string, unknown>;
}

/** Payload of a `sync.delta` message. */
export interface SyncDelta {
  table: "memories" | "tasks" | "conversations" | "settings";
  rowId: string;
  updatedAt: number;
  by: string;
  deleted: boolean;
  data?: Record<string, unknown>;
}

export type SyncSnapshot = Record<string, Record<string, SyncRow>>;

export function wins(incoming: { updatedAt: number; by: string }, existing?: { updatedAt: number; by: string }): boolean {
  if (!existing) return true;
  if (incoming.updatedAt !== existing.updatedAt) return incoming.updatedAt > existing.updatedAt;
  return incoming.by > existing.by;
}

export class SyncStore {
  private tables: SyncSnapshot;
  private clock = 0;
  private listeners = new Set<(d: SyncDelta, local: boolean) => void>();

  constructor(private deviceId: string, initial: SyncSnapshot = {}, private now: () => number = Date.now) {
    this.tables = initial;
    for (const rows of Object.values(initial)) for (const r of Object.values(rows)) this.clock = Math.max(this.clock, r.updatedAt);
  }

  onChange(fn: (d: SyncDelta, local: boolean) => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }

  private stamp() { this.clock = Math.max(this.now(), this.clock + 1); return this.clock; }

  private put(d: SyncDelta, local: boolean) {
    (this.tables[d.table] ??= {})[d.rowId] = { updatedAt: d.updatedAt, by: d.by, deleted: d.deleted, data: d.deleted ? undefined : d.data };
    this.listeners.forEach((f) => f(d, local));
  }

  /** Local write. Returns the delta to broadcast. */
  set(table: SyncDelta["table"], rowId: string, data: Record<string, unknown>): SyncDelta {
    const d: SyncDelta = { table, rowId, updatedAt: this.stamp(), by: this.deviceId, deleted: false, data };
    this.put(d, true);
    return d;
  }

  remove(table: SyncDelta["table"], rowId: string): SyncDelta {
    const d: SyncDelta = { table, rowId, updatedAt: this.stamp(), by: this.deviceId, deleted: true };
    this.put(d, true);
    return d;
  }

  /** Apply a delta from another device. Returns true if it changed local state. */
  apply(d: SyncDelta): boolean {
    this.clock = Math.max(this.clock, d.updatedAt);
    if (!wins(d, this.tables[d.table]?.[d.rowId])) return false;
    this.put(d, false);
    return true;
  }

  get(table: SyncDelta["table"], rowId: string): Record<string, unknown> | undefined {
    const r = this.tables[table]?.[rowId];
    return r && !r.deleted ? r.data : undefined;
  }

  /** Everything we know (tombstones included), as deltas, for the connect-time exchange. */
  all(): SyncDelta[] {
    const out: SyncDelta[] = [];
    for (const [table, rows] of Object.entries(this.tables))
      for (const [rowId, r] of Object.entries(rows)) out.push({ table: table as SyncDelta["table"], rowId, updatedAt: r.updatedAt, by: r.by, deleted: r.deleted, data: r.data });
    return out;
  }

  toJSON(): SyncSnapshot { return this.tables; }
}
