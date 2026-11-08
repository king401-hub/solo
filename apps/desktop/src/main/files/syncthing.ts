import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { mkdirSync } from "node:fs";

export interface Privacy {
  /** Find devices on other networks through Syncthing's public discovery servers. Needed to sync across the internet. */
  globalDiscovery: boolean;
  /** Fall back to Syncthing's public relays (traffic stays end-to-end encrypted) when a direct connection fails. */
  relays: boolean;
  /** Ask the router to open a port (UPnP / NAT-PMP) so direct connections work. */
  nat: boolean;
  /** Find devices on the same LAN. */
  localDiscovery: boolean;
}
export const defaultPrivacy: Privacy = { globalDiscovery: true, relays: true, nat: true, localDiscovery: true };

export interface SyncthingOptions {
  binary: string;
  home: string;
  privacy?: Privacy;
  /** Fixed ports are for tests; the app lets the manager pick a free GUI port. */
  guiPort?: number;
  listenPort?: number;
  listenHost?: string;
  apiKey?: string;
  /** Bytes/s caps, used by tests to make transfers slow enough to interrupt. */
  maxRecvKbps?: number;
}

export interface FolderSpec {
  id: string;
  label: string;
  path: string;
  deviceIds: string[];
  versioning?: { type: "none" | "staggered" | "trashcan" | "simple"; maxAgeDays?: number; keep?: number };
  fsWatcherDelayS?: number;
  rescanIntervalS?: number;
  watcher?: boolean;
  ignore?: string[];
}

export interface FolderSummary {
  id: string; label: string; path: string; paused: boolean;
  state: string; // idle | scanning | syncing | error | unknown | paused ...
  percent: number; needBytes: number; needFiles: number; globalBytes: number; globalFiles: number; errors: number;
  deviceIds: string[];
}
export interface DeviceSummary { id: string; name: string; connected: boolean; address?: string; paused: boolean }

export const freePort = () => new Promise<number>((res, rej) => {
  const s = createServer();
  s.once("error", rej);
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); });
});

/**
 * Runs Syncthing (the file synchronisation engine) as a hidden child process bound to 127.0.0.1 with a random API key,
 * and drives it through its REST API. Solo adds pairing, safe defaults, conflict/history handling and UI on top.
 * Syncthing is MPL-2.0 licensed; it is shipped unmodified.
 */
export class SyncthingManager extends EventEmitter<{ exit: [number | null]; log: [string] }> {
  private proc?: ChildProcess;
  readonly apiKey: string;
  private port = 0;
  private _myId = "";
  private stopping = false;
  private logTail: string[] = [];

  constructor(private o: SyncthingOptions) { super(); this.apiKey = o.apiKey ?? randomBytes(24).toString("hex"); }

  get myId() { return this._myId; }
  get running() { return !!this.proc && this.proc.exitCode === null; }
  get recentLog() { return this.logTail.slice(-30); }
  private get base() { return `http://127.0.0.1:${this.port}`; }
  /** Address of the local-only control API (exposed for diagnostics/tests). */
  get guiUrl() { return this.base; }

  /**
   * Start the engine. Right after a crash or hard kill the previous process's lock on the database folder can linger for
   * a moment, so a "failed to acquire lock" exit is retried for a few seconds instead of being reported as a failure.
   */
  async start(timeoutMs = 60_000): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try { await this.startOnce(timeoutMs); return; }
      catch (e) {
        const lock = e instanceof Error && /Failed to acquire lock/i.test(e.message);
        if (!lock || attempt >= 8) throw e;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  private async startOnce(timeoutMs: number): Promise<void> {
    if (this.running) return;
    this.stopping = false;
    this.logTail = [];
    mkdirSync(this.o.home, { recursive: true });
    this.port = this.o.guiPort ?? (await freePort());
    const proc = spawn(this.o.binary, [
      "serve", "--home", this.o.home, "--no-browser", "--no-upgrade", "--no-restart",
      "--gui-address", `127.0.0.1:${this.port}`, "--gui-apikey", this.apiKey,
    ], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, STNODEFAULTFOLDER: "1", STNOUPGRADE: "1" } });
    this.proc = proc;
    const keep = (b: Buffer) => { for (const l of b.toString().split(/\r?\n/)) if (l.trim()) { this.logTail.push(l); if (this.logTail.length > 200) this.logTail.shift(); this.emit("log", l); } };
    proc.stdout?.on("data", keep); proc.stderr?.on("data", keep);
    proc.on("exit", (code) => { if (this.proc === proc) this.proc = undefined; this.emit("exit", code); });

    const end = Date.now() + timeoutMs;
    for (;;) {
      if (!this.running) throw new Error(`Syncthing exited during start-up:\n${this.recentLog.join("\n")}`);
      try { const r = await fetch(`${this.base}/rest/noauth/health`); if (r.ok) break; } catch { /* not up yet */ }
      if (Date.now() > end) { this.kill(); throw new Error("Syncthing did not start in time"); }
      await new Promise((r) => setTimeout(r, 150));
    }
    this._myId = (await this.api<{ myID: string }>("GET", "/rest/system/status")).myID;
    await this.applyOptions();
  }

  /** Graceful shutdown (so the database is closed cleanly); force-kill only if it does not exit. Resolves once the process is gone. */
  async stop(gracefulMs = 30_000): Promise<void> {
    const p = this.proc;
    if (!p) return;
    this.stopping = true;
    // Register the exit listener BEFORE asking it to quit: a fast exit would otherwise be missed.
    const exited = new Promise<void>((res) => { if (p.exitCode !== null) res(); else p.once("exit", () => res()); });
    const within = (ms: number) => Promise.race([exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);
    try { await this.api("POST", "/rest/system/shutdown"); } catch { /* fall through to kill */ }
    if (await within(gracefulMs)) return;
    this.kill();
    await within(10_000);
  }

  /** Abrupt termination, as in a crash or power loss: no graceful shutdown. Used to prove interrupted work is recovered. */
  async crash(): Promise<void> {
    const p = this.proc;
    if (!p) return;
    this.stopping = true;
    const exited = new Promise<void>((res) => { if (p.exitCode !== null) res(); else p.once("exit", () => res()); });
    this.kill();
    await Promise.race([exited, new Promise<void>((r) => setTimeout(r, 10_000))]);
  }

  /**
   * Syncthing runs as a supervisor plus a worker child. Killing only the supervisor would orphan the worker, which keeps
   * the database lock (so the next start fails) and keeps syncing in the background. Kill the whole tree.
   */
  private kill() {
    const p = this.proc;
    if (!p || p.pid === undefined) return;
    try {
      if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(p.pid), "/T", "/F"], { windowsHide: true });
      else p.kill("SIGKILL");
    } catch { /* already gone */ }
  }
  get wasStopped() { return this.stopping; }

  async api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await fetch(`${this.base}${path}`, {
      method,
      headers: { "X-API-Key": this.apiKey, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) throw new Error(`Syncthing ${method} ${path} -> ${r.status} ${(await r.text()).slice(0, 300)}`);
    const text = await r.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  // ---- configuration ----------------------------------------------------------------------------------------

  private async applyOptions() {
    const p = this.o.privacy ?? defaultPrivacy;
    const host = this.o.listenHost ?? "0.0.0.0";
    const port = this.o.listenPort;
    const options: Record<string, unknown> = {
      urAccepted: -1, // never send usage reports
      crashReportingEnabled: false,
      startBrowser: false,
      autoUpgradeIntervalH: 0,
      globalAnnounceEnabled: p.globalDiscovery,
      relaysEnabled: p.relays,
      natEnabled: p.nat,
      localAnnounceEnabled: p.localDiscovery,
      ...(port ? { listenAddresses: [`tcp://${host}:${port}`, ...(host === "0.0.0.0" ? [`quic://${host}:${port}`] : [])] } : {}),
      ...(this.o.maxRecvKbps ? { maxRecvKbps: this.o.maxRecvKbps } : {}),
    };
    await this.api("PATCH", "/rest/config/options", options);
  }

  async setPrivacy(p: Privacy) {
    this.o.privacy = p;
    await this.api("PATCH", "/rest/config/options", {
      globalAnnounceEnabled: p.globalDiscovery, relaysEnabled: p.relays, natEnabled: p.nat, localAnnounceEnabled: p.localDiscovery,
    });
  }

  /** Bandwidth caps in KiB/s (0 = unlimited). */
  async setLimits(l: { maxRecvKbps?: number; maxSendKbps?: number; limitBandwidthInLan?: boolean }) {
    await this.api("PATCH", "/rest/config/options", l);
  }

  async addDevice(id: string, name: string, addresses: string[] = ["dynamic"]) {
    await this.api("PUT", `/rest/config/devices/${id}`, {
      deviceID: id, name, addresses, compression: "metadata", introducer: false, autoAcceptFolders: false, paused: false,
    });
  }

  async removeDevice(id: string) { await this.api("DELETE", `/rest/config/devices/${id}`); }

  async addFolder(f: FolderSpec) {
    mkdirSync(f.path, { recursive: true });
    const v = f.versioning ?? { type: "staggered", maxAgeDays: 90 };
    const versioning = v.type === "none" ? { type: "" } : {
      type: v.type,
      params: v.type === "staggered" ? { maxAge: String((v.maxAgeDays ?? 90) * 86400), cleanInterval: "3600" }
        : v.type === "trashcan" ? { cleanoutDays: String(v.maxAgeDays ?? 90) }
        : { keep: String(v.keep ?? 10), cleanoutDays: String(v.maxAgeDays ?? 90) },
      cleanupIntervalS: 3600,
    };
    const ids = [...new Set([this._myId, ...f.deviceIds])];
    await this.api("PUT", `/rest/config/folders/${f.id}`, {
      id: f.id, label: f.label, path: f.path, type: "sendreceive",
      devices: ids.map((d) => ({ deviceID: d })),
      fsWatcherEnabled: f.watcher ?? true,
      fsWatcherDelayS: f.fsWatcherDelayS ?? 2, // changes are picked up about 2 s after the last write
      rescanIntervalS: f.rescanIntervalS ?? 300, // periodic reconciliation catches anything the watcher missed
      ignorePerms: false, markerName: ".stfolder", versioning,
    });
    if (f.ignore) await this.setIgnores(f.id, f.ignore);
  }

  async removeFolder(id: string) { await this.api("DELETE", `/rest/config/folders/${id}`); }

  /** Share an existing folder with another (already added) device. */
  async shareFolder(folderId: string, deviceId: string) {
    const f = await this.api<{ devices: { deviceID: string }[] }>("GET", `/rest/config/folders/${folderId}`);
    if (f.devices.some((d) => d.deviceID === deviceId)) return;
    await this.api("PATCH", `/rest/config/folders/${folderId}`, { devices: [...f.devices, { deviceID: deviceId }] });
  }

  async setIgnores(folderId: string, lines: string[]) {
    await this.api("POST", `/rest/db/ignores?folder=${encodeURIComponent(folderId)}`, { ignore: lines });
  }
  async getIgnores(folderId: string): Promise<string[]> {
    return (await this.api<{ ignore: string[] | null }>("GET", `/rest/db/ignores?folder=${encodeURIComponent(folderId)}`)).ignore ?? [];
  }

  async scan(folderId: string) { await this.api("POST", `/rest/db/scan?folder=${encodeURIComponent(folderId)}`); }

  // ---- status -----------------------------------------------------------------------------------------------

  async pendingFolders(): Promise<{ folderId: string; label: string; offeredBy: string[] }[]> {
    const p = await this.api<Record<string, { offeredBy: Record<string, { label?: string }> }>>("GET", "/rest/cluster/pending/folders");
    return Object.entries(p ?? {}).map(([folderId, v]) => ({
      folderId, offeredBy: Object.keys(v.offeredBy ?? {}),
      label: Object.values(v.offeredBy ?? {}).find((o) => o.label)?.label ?? folderId,
    }));
  }

  async summary(): Promise<{ myId: string; devices: DeviceSummary[]; folders: FolderSummary[] }> {
    const cfg = await this.api<{ devices: { deviceID: string; name: string; paused: boolean }[]; folders: { id: string; label: string; path: string; paused: boolean; devices: { deviceID: string }[] }[] }>("GET", "/rest/config");
    const conns = (await this.api<{ connections: Record<string, { connected: boolean; address: string }> }>("GET", "/rest/system/connections")).connections ?? {};
    const devices = cfg.devices.filter((d) => d.deviceID !== this._myId).map((d) => ({
      id: d.deviceID, name: d.name || d.deviceID.slice(0, 7), paused: d.paused,
      connected: !!conns[d.deviceID]?.connected, address: conns[d.deviceID]?.connected ? conns[d.deviceID]!.address : undefined,
    }));
    const folders: FolderSummary[] = [];
    for (const f of cfg.folders) {
      let s: Record<string, number | string> = {};
      try { s = await this.api("GET", `/rest/db/status?folder=${encodeURIComponent(f.id)}`); } catch { /* folder still starting */ }
      const global = Number(s["globalBytes"] ?? 0), need = Number(s["needBytes"] ?? 0);
      folders.push({
        id: f.id, label: f.label || f.id, path: f.path, paused: f.paused,
        state: f.paused ? "paused" : String(s["state"] ?? "unknown"),
        percent: global > 0 ? Math.round(((global - need) / global) * 100) : 100,
        needBytes: need, needFiles: Number(s["needFiles"] ?? 0), globalBytes: global, globalFiles: Number(s["globalFiles"] ?? 0),
        errors: Number(s["errors"] ?? 0), deviceIds: f.devices.map((d) => d.deviceID).filter((d) => d !== this._myId),
      });
    }
    return { myId: this._myId, devices, folders };
  }

  async folderErrors(folderId: string): Promise<{ path: string; error: string }[]> {
    return (await this.api<{ errors: { path: string; error: string }[] | null }>("GET", `/rest/folder/errors?folder=${encodeURIComponent(folderId)}`)).errors ?? [];
  }

  /** Wait until a folder reports idle with nothing left to fetch (test and UI helper). */
  async waitIdle(folderId: string, timeoutMs = 60_000) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      try {
        const s = await this.api<{ state: string; needFiles: number; needBytes: number }>("GET", `/rest/db/status?folder=${encodeURIComponent(folderId)}`);
        if (s.state === "idle" && s.needFiles === 0 && s.needBytes === 0) return;
      } catch { /* retry */ }
      if (Date.now() > end) throw new Error(`folder ${folderId} did not become idle`);
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}
