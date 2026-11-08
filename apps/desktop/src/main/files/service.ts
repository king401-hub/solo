import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { SYNCTHING_ID } from "@solo/shared";
import type { HubLike } from "../link/hub";
import type { DeviceStore } from "../link/store";
import { SyncthingManager, defaultPrivacy, type FolderSummary, type Privacy } from "./syncthing";
import { buildIgnoreList, defaultIgnoreOptions, type IgnoreOptions } from "./ignore";
import { listConflicts, listVersions, resolveConflict, restoreVersion, safeJoin, type Conflict, type ConflictAction, type Trash, type VersionEntry } from "./conflicts";

interface Settings { enabled: boolean; privacy: Privacy; peers: Record<string, string> } // peers: Solo device id -> Syncthing id

export interface FileSyncState {
  available: boolean; // the Syncthing binary is installed
  enabled: boolean;
  running: boolean;
  error?: string;
  myId?: string;
  privacy: Privacy;
  devices: { soloId: string; name: string; syncthingId?: string; connected: boolean; online: boolean }[];
  folders: (FolderSummary & { conflicts: number; deviceNames: string[] })[];
  pending: { folderId: string; label: string; offeredBy: string[] }[];
}

export interface AddFolderInput {
  path: string; label: string; deviceSoloIds: string[];
  ignore?: Partial<IgnoreOptions>; extraIgnore?: string[]; keepDays?: number;
}

/**
 * Solo's layer over the Syncthing engine:
 *  - devices Solo already trusts introduce their sync identity to each other over the encrypted Solo link (no copying
 *    of 63-character ids), but sharing a folder is always an explicit choice on both sides;
 *  - safe defaults (exclusions, history, periodic rescans), conflict and history handling, status for the UI.
 * The files stay in their ordinary folders on each device; nothing is uploaded to a Solo server.
 */
export function createFiles(o: {
  dir: string; binary: string; hub: HubLike; store: DeviceStore; selfName: () => string; trash: Trash; onChange: () => void;
  /** Overrides for tests: fixed listen port/host and known addresses for peers (instead of discovery). */
  listenPort?: number; listenHost?: string; privacy?: Privacy; deviceAddresses?: (syncthingId: string) => string[] | undefined;
}) {
  const settingsFile = join(o.dir, "files-settings.json");
  const load = (): Settings => {
    try { const j = JSON.parse(readFileSync(settingsFile, "utf8")); return { enabled: !!j.enabled, privacy: { ...defaultPrivacy, ...j.privacy }, peers: j.peers ?? {} }; }
    catch { return { enabled: false, privacy: { ...defaultPrivacy }, peers: {} }; }
  };
  let settings = load();
  const save = () => { mkdirSync(o.dir, { recursive: true }); writeFileSync(settingsFile, JSON.stringify(settings)); };

  const available = existsSync(o.binary);
  let mgr: SyncthingManager | undefined;
  let error: string | undefined;
  let restarts = 0;
  let starting: Promise<void> | undefined;

  const peerName = (soloId: string) => { const r = o.store.get(soloId); return r?.alias ?? r?.device.name ?? soloId.slice(0, 8); };
  const soloIdOf = (stId: string) => Object.entries(settings.peers).find(([, v]) => v === stId)?.[0];
  const nameOfSt = (stId: string) => { const s = soloIdOf(stId); return s ? peerName(s) : stId.slice(0, 7); };

  function announce(to?: string) {
    if (!mgr?.running || !mgr.myId) return;
    const targets = to ? [to] : o.hub.onlineDeviceIds;
    for (const id of targets) o.hub.send(id, "files.device", { syncthingId: mgr.myId, name: o.selfName() });
  }

  async function introduce(soloId: string, stId: string) {
    settings.peers[soloId] = stId; save();
    if (mgr?.running) await mgr.addDevice(stId, peerName(soloId), o.deviceAddresses?.(stId));
    o.onChange();
  }

  async function startEngine() {
    if (!available || mgr?.running || starting) return starting;
    starting = (async () => {
      error = undefined;
      const m = new SyncthingManager({ binary: o.binary, home: join(o.dir, "syncthing"), privacy: o.privacy ?? settings.privacy, listenPort: o.listenPort ?? 22327, listenHost: o.listenHost });
      try {
        await m.start();
        mgr = m;
        for (const [soloId, stId] of Object.entries(settings.peers)) { try { await m.addDevice(stId, peerName(soloId), o.deviceAddresses?.(stId)); } catch { /* retried on next introduction */ } }
        m.on("exit", () => {
          if (mgr !== m || m.wasStopped) return;
          error = "File sync stopped unexpectedly";
          o.onChange();
          if (restarts++ < 5) setTimeout(() => { if (settings.enabled) void startEngine(); }, 3000 * restarts);
        });
        announce();
      } catch (e) {
        error = e instanceof Error ? e.message.split("\n")[0] : String(e);
        mgr = undefined;
      } finally { starting = undefined; o.onChange(); }
    })();
    return starting;
  }

  async function stopEngine() { const m = mgr; mgr = undefined; await m?.stop(); o.onChange(); }

  // A device Solo trusts told us its sync identity (or came online): exchange identities.
  o.hub.on("connected", (d) => announce(d.deviceId));
  o.hub.on("message", (from, env) => {
    if (env.type !== "files.device" || !o.store.get(from) || o.store.get(from)?.revoked) return;
    const p = env.payload as { syncthingId: string };
    if (!SYNCTHING_ID.test(p.syncthingId)) return;
    if (settings.peers[from] !== p.syncthingId) void introduce(from, p.syncthingId);
  });

  const need = (): SyncthingManager => { if (!mgr?.running) throw new Error("File sync is not running"); return mgr; };
  const folderPath = async (id: string) => (await need().api<{ path: string }>("GET", `/rest/config/folders/${encodeURIComponent(id)}`)).path;
  const newId = () => `solo-${randomBytes(4).toString("hex")}`;
  const stIds = (soloIds: string[]) => soloIds.map((s) => settings.peers[s]).filter((x): x is string => !!x);

  return {
    available,
    get enabled() { return settings.enabled; },

    async setEnabled(on: boolean) {
      settings.enabled = on; save();
      if (on) { restarts = 0; await startEngine(); } else await stopEngine();
      o.onChange();
    },

    async setPrivacy(p: Privacy) {
      settings.privacy = { ...settings.privacy, ...p }; save();
      if (mgr?.running) await mgr.setPrivacy(settings.privacy);
      o.onChange();
    },

    async state(): Promise<FileSyncState> {
      const base: FileSyncState = { available, enabled: settings.enabled, running: !!mgr?.running, error, privacy: settings.privacy, devices: [], folders: [], pending: [] };
      const known = o.store.list().filter((d) => !d.revoked);
      base.devices = known.map((d) => ({ soloId: d.device.deviceId, name: d.alias ?? d.device.name, syncthingId: settings.peers[d.device.deviceId], connected: false, online: o.hub.onlineDeviceIds.includes(d.device.deviceId) }));
      if (!mgr?.running) return base;
      try {
        const s = await mgr.summary();
        base.myId = s.myId;
        for (const d of base.devices) d.connected = !!s.devices.find((x) => x.id === d.syncthingId)?.connected;
        base.folders = s.folders.map((f) => ({
          ...f, deviceNames: f.deviceIds.map(nameOfSt),
          conflicts: f.state === "error" ? 0 : (() => { try { return listConflicts(f.path).length; } catch { return 0; } })(),
        }));
        base.pending = (await mgr.pendingFolders()).map((p) => ({ folderId: p.folderId, label: p.label, offeredBy: p.offeredBy.map(nameOfSt) }));
      } catch (e) { base.error = e instanceof Error ? e.message : String(e); }
      return base;
    },

    async addFolder(i: AddFolderInput) {
      const m = need();
      const id = newId();
      const ids = stIds(i.deviceSoloIds);
      await m.addFolder({
        id, label: i.label || i.path, path: i.path, deviceIds: ids,
        versioning: { type: "staggered", maxAgeDays: i.keepDays ?? 90 },
        ignore: buildIgnoreList({ ...defaultIgnoreOptions, ...i.ignore }, i.extraIgnore ?? []),
      });
      o.onChange();
      return id;
    },

    /** Accept a folder another device offered, keeping it at a path of this device's choosing. */
    async acceptPending(folderId: string, path: string, ignore?: Partial<IgnoreOptions>) {
      const m = need();
      const p = (await m.pendingFolders()).find((x) => x.folderId === folderId);
      if (!p) throw new Error("That offer is no longer available");
      await m.addFolder({
        id: folderId, label: p.label, path, deviceIds: p.offeredBy,
        versioning: { type: "staggered", maxAgeDays: 90 },
        ignore: buildIgnoreList({ ...defaultIgnoreOptions, ...ignore }),
      });
      o.onChange();
    },

    async share(folderId: string, soloId: string) {
      const st = settings.peers[soloId];
      if (!st) throw new Error("That device has not shared its file-sync identity yet (is it online with File sync turned on?)");
      await need().shareFolder(folderId, st);
      o.onChange();
    },

    async removeFolder(folderId: string) { await need().removeFolder(folderId); o.onChange(); },
    async setPaused(folderId: string, paused: boolean) { await need().api("PATCH", `/rest/config/folders/${encodeURIComponent(folderId)}`, { paused }); o.onChange(); },
    async rescan(folderId: string) { await need().scan(folderId); },
    async getIgnores(folderId: string) { return need().getIgnores(folderId); },
    async setIgnores(folderId: string, lines: string[]) { await need().setIgnores(folderId, lines.slice(0, 500)); await need().scan(folderId); },
    async errors(folderId: string) { return need().folderErrors(folderId); },

    async conflicts(folderId: string): Promise<Conflict[]> { return listConflicts(await folderPath(folderId)); },
    async resolve(folderId: string, conflictRel: string, action: ConflictAction) {
      await resolveConflict(await folderPath(folderId), conflictRel, action, o.trash);
      await need().scan(folderId);
      o.onChange();
    },
    async versions(folderId: string, originalRel?: string): Promise<VersionEntry[]> { return listVersions(await folderPath(folderId), originalRel); },
    async restore(folderId: string, versionRel: string) {
      const rel = await restoreVersion(await folderPath(folderId), versionRel, o.trash);
      await need().scan(folderId);
      return rel;
    },
    /** Absolute path of a file inside a synced folder (validated), for "show in folder". */
    async absPath(folderId: string, rel: string) { return safeJoin(await folderPath(folderId), rel); },
    async folderRoot(folderId: string) { return folderPath(folderId); },

    start: () => (settings.enabled ? startEngine() : Promise.resolve()),
    stop: stopEngine,
    announce,
    /** exposed for tests */
    get engine() { return mgr; },
    get peers() { return settings.peers; },
  };
}
export type FilesService = ReturnType<typeof createFiles>;
