import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SyncStore, type SyncDelta, type SyncSnapshot } from "@solo/shared";
import type { LinkServer } from "../link/server";

function load(file: string): SyncSnapshot {
  if (!existsSync(file)) return {};
  try { return JSON.parse(readFileSync(file, "utf8")) as SyncSnapshot; } catch { return {}; } // corrupt: start empty, peers repopulate
}

/**
 * Keeps this PC's SyncStore equal to every connected device:
 *  - on connect, send our whole state (the phone sends its own); last-writer-wins resolves the rest
 *  - local edits are pushed to all online devices; remote edits are applied and relayed to the others
 */
export function createSync(opts: { file: string; deviceId: string; server: LinkServer; onChange: (d: SyncDelta, local: boolean) => void }) {
  const store = new SyncStore(opts.deviceId, load(opts.file));
  let timer: NodeJS.Timeout | undefined;
  const write = () => {
    mkdirSync(dirname(opts.file), { recursive: true });
    const tmp = opts.file + ".tmp";
    writeFileSync(tmp, JSON.stringify(store.toJSON()));
    renameSync(tmp, opts.file);
  };
  const save = () => { clearTimeout(timer); timer = setTimeout(write, 200); };
  const push = (to: string, d: SyncDelta) => opts.server.send(to, "sync.delta", d);
  let relayingFrom: string | undefined;

  store.onChange((d, local) => {
    save();
    for (const id of opts.server.onlineDeviceIds) if (id !== relayingFrom) push(id, d);
    opts.onChange(d, local);
  });
  opts.server.on("connected", (dev) => { for (const d of store.all()) push(dev.deviceId, d); });
  opts.server.on("message", (from, env) => {
    if (env.type !== "sync.delta") return;
    relayingFrom = from;
    try { store.apply(env.payload as SyncDelta); } finally { relayingFrom = undefined; }
  });
  return { store, flush: () => { clearTimeout(timer); write(); } };
}
