import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { buildIgnoreList } from "./ignore";
import { listConflicts, listVersions, restoreVersion } from "./conflicts";
import { SyncthingManager, freePort } from "./syncthing";

/**
 * Real two-device synchronisation using the bundled Syncthing engine (skipped if the binary is not present; run
 * tools/fetch-syncthing.ps1 first). Two independent Syncthing instances with their own keys and databases play the
 * "HP" and the "Dell". They talk over loopback, so this proves the sync logic, offline catch-up, conflicts, history and
 * recovery with real files on disk; it does NOT prove NAT traversal between different internet connections.
 */
const BIN = resolve(__dirname, "../../../resources/syncthing/syncthing.exe");
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean | Promise<boolean>, ms = 60_000, what = "condition") {
  const end = Date.now() + ms;
  while (!(await f())) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(250); }
}
const put = (root: string, rel: string, data: string | Buffer) => { const p = join(root, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, data); };
/** Syncthing swaps files in place, so a file can be briefly absent mid-update; treat that as "not there yet". */
const read = (root: string, rel: string) => { try { return readFileSync(join(root, rel), "utf8"); } catch { return "<missing>"; } };
/** Every file under root (excluding Syncthing's own bookkeeping) as relpath -> sha256. */
function tree(root: string, skip = [".stfolder", ".stversions", ".stignore"]): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => { let entries; try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of entries) {
    if (skip.includes(e.name) || e.name.startsWith(".syncthing.") || e.name.endsWith(".tmp") && e.name.includes("syncthing")) continue;
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p);
    else { try { out[relative(root, p).split("\\").join("/")] = sha(p); } catch { /* the engine moved or deleted it while we looked; the caller polls again */ } }
  } };
  walk(root); return out;
}
const sameTree = (a: string, b: string) => JSON.stringify(tree(a)) === JSON.stringify(tree(b));

interface Node { name: string; m: SyncthingManager; dir: string; listen: number; root: (f: string) => string }
async function makeNode(name: string): Promise<Node> {
  const dir = mkdtempSync(join(tmpdir(), `solo-st-${name}-`));
  const listen = await freePort();
  const m = new SyncthingManager({
    binary: BIN, home: join(dir, "home"), listenPort: listen, listenHost: "127.0.0.1",
    privacy: { globalDiscovery: false, relays: false, nat: false, localDiscovery: false },
  });
  await m.start();
  return { name, m, dir, listen, root: (f) => join(dir, "data", f) };
}

describe.skipIf(!existsSync(BIN))("file synchronisation between two devices (real Syncthing)", () => {
  let hp: Node, dell: Node;
  const trashed: string[] = [];
  const trash = (p: string) => { trashed.push(p); rmSync(p); };

  /** The user flow: A shares a folder with B, B accepts it into a folder of its own. */
  async function share(id: string, opts: { ignore?: string[]; watcher?: boolean; rescan?: number } = {}) {
    const a = hp.root(id), b = dell.root(id);
    await hp.m.addFolder({ id, label: id, path: a, deviceIds: [dell.m.myId], fsWatcherDelayS: 1, ignore: opts.ignore, watcher: opts.watcher, rescanIntervalS: opts.rescan });
    await dell.m.addFolder({ id, label: id, path: b, deviceIds: [hp.m.myId], fsWatcherDelayS: 1, watcher: opts.watcher, rescanIntervalS: opts.rescan, ignore: opts.ignore });
    return { a, b };
  }

  beforeAll(async () => {
    [hp, dell] = await Promise.all([makeNode("hp"), makeNode("dell")]);
    await hp.m.addDevice(dell.m.myId, "Dell", [`tcp://127.0.0.1:${dell.listen}`]);
    await dell.m.addDevice(hp.m.myId, "HP", [`tcp://127.0.0.1:${hp.listen}`]);
    await until(async () => (await hp.m.summary()).devices.find((d) => d.id === dell.m.myId)?.connected === true, 60_000, "HP and Dell to connect");
  }, 120_000);

  afterAll(async () => {
    await Promise.allSettled([hp?.m.stop(), dell?.m.stop()]);
    for (const n of [hp, dell]) if (n) rmSync(n.dir, { recursive: true, force: true });
  }, 60_000);

  it("syncs a project's real files both ways: creation, edits, rename, delete", async () => {
    const { a, b } = await share("basic");
    put(a, "src/App.tsx", "export const App = () => 'v1';\n");
    put(a, "README.md", "# SchoolDom\n");
    put(a, "src/components/deep/Button.tsx", "export const Button = 1;\n");
    await until(() => sameTree(a, b) && Object.keys(tree(b)).length === 3, 60_000, "initial sync");

    put(a, "src/App.tsx", "export const App = () => 'v2 edited on HP';\n");
    await until(() => read(b, "src/App.tsx").includes("v2"), 45_000, "edit to reach Dell");

    put(b, "src/NewFromDell.ts", "export const x = 1;\n"); // and the other direction
    await until(() => existsSync(join(a, "src/NewFromDell.ts")), 45_000, "Dell's new file to reach HP");

    renameSync(join(a, "README.md"), join(a, "docs-README.md"));
    await until(() => existsSync(join(b, "docs-README.md")) && !existsSync(join(b, "README.md")), 45_000, "rename");
    rmSync(join(a, "src/App.tsx"));
    await until(() => !existsSync(join(b, "src/App.tsx")), 45_000, "delete");
    await until(() => sameTree(a, b), 30_000, "trees to match");
  }, 180_000);

  it("keeps ignored files local: dependencies, build output, databases and .git never leave the machine", async () => {
    const { a, b } = await share("ignore", { ignore: buildIgnoreList() });
    put(a, "node_modules/left-pad/index.js", "module.exports = 1");
    put(a, "dist/bundle.js", "built");
    put(a, "data/app.sqlite", "SQLite format 3");
    put(a, "data/app.sqlite-wal", "wal");
    put(a, ".git/config", "[core]");
    put(a, "package-lock.json", "{}"); // must NOT be ignored
    put(a, "src/ok.ts", "export {}");
    await until(() => existsSync(join(b, "src/ok.ts")) && existsSync(join(b, "package-lock.json")), 60_000, "allowed files");
    await sleep(4000); // give excluded files every chance to leak
    for (const p of ["node_modules/left-pad/index.js", "dist/bundle.js", "data/app.sqlite", "data/app.sqlite-wal", ".git/config"]) expect(existsSync(join(b, p)), p).toBe(false);
  }, 120_000);

  it("OFFLINE SCENARIO: Dell keeps editing while HP is off, and HP catches up when it comes back", async () => {
    const { a, b } = await share("offline");
    put(a, "App.tsx", "original");
    put(a, "keep.txt", "unchanged");
    put(a, "old-name.txt", "will be renamed");
    put(a, "to-delete.txt", "will be deleted");
    await until(() => sameTree(a, b) && Object.keys(tree(b)).length === 4, 60_000, "initial sync");

    await hp.m.stop(); // the HP is switched off
    expect(hp.m.running).toBe(false);

    // the user keeps working on the Dell with ordinary tools (here: plain file writes)
    put(b, "App.tsx", "edited on the Dell while HP was off");
    put(b, "src/new/Feature.ts", "export const feature = true;");
    const big = randomBytes(8 * 1024 * 1024); put(b, "assets/model.bin", big);
    renameSync(join(b, "old-name.txt"), join(b, "new-name.txt"));
    rmSync(join(b, "to-delete.txt"));
    await dell.m.scan("offline");
    await dell.m.waitIdle("offline");
    expect(sameTree(a, b)).toBe(false); // HP is genuinely behind

    await hp.m.start(); // the HP is switched on later
    await until(async () => (await hp.m.summary()).devices.find((d) => d.id === dell.m.myId)?.connected === true, 60_000, "HP to reconnect");
    await until(() => sameTree(a, b), 90_000, "HP to catch up");

    expect(read(a, "App.tsx")).toBe("edited on the Dell while HP was off");
    expect(sha(join(a, "assets/model.bin"))).toBe(createHash("sha256").update(big).digest("hex")); // integrity of the large file
    expect(existsSync(join(a, "new-name.txt"))).toBe(true);
    expect(existsSync(join(a, "old-name.txt"))).toBe(false);
    expect(existsSync(join(a, "to-delete.txt"))).toBe(false);
    expect(read(a, "keep.txt")).toBe("unchanged");
  }, 240_000);

  it("CONFLICT: edits made on both devices while apart are both preserved, never silently overwritten", async () => {
    const { a, b } = await share("conflict");
    put(a, "App.tsx", "base");
    await until(() => existsSync(join(b, "App.tsx")), 60_000, "initial sync");

    await dell.m.stop();
    put(a, "App.tsx", "HP version");
    put(b, "App.tsx", "Dell version"); // Dell is stopped, but the user still edits the file on disk
    const later = new Date(Date.now() + 5000); utimesSync(join(b, "App.tsx"), later, later); // Dell edit is newer
    await dell.m.start();
    await until(async () => (await hp.m.summary()).devices.find((d) => d.id === dell.m.myId)?.connected === true, 60_000, "reconnect");

    await until(() => listConflicts(a).length === 1 && listConflicts(b).length === 1 && read(a, "App.tsx") === read(b, "App.tsx"), 90_000, "conflict to be detected");
    const winner = read(a, "App.tsx");
    const loser = read(a, listConflicts(a)[0]!.conflictRel);
    expect(new Set([winner, loser])).toEqual(new Set(["HP version", "Dell version"])); // nothing lost
    expect(winner).toBe("Dell version"); // the newer edit wins; the other is kept beside it
    expect(read(b, listConflicts(b)[0]!.conflictRel)).toBe(loser); // the conflict copy exists on both machines
  }, 240_000);

  it("HISTORY: an overwritten file is archived and can be restored", async () => {
    const { a, b } = await share("history");
    put(a, "doc.txt", "version 1");
    await until(() => existsSync(join(b, "doc.txt")), 60_000, "initial sync");
    put(a, "doc.txt", "version 2");
    await until(() => read(b, "doc.txt") === "version 2", 45_000, "update");
    await until(() => listVersions(b, "doc.txt").length >= 1, 30_000, "archived version");
    const v = listVersions(b, "doc.txt")[0]!;
    expect(readFileSync(join(b, ".stversions", v.versionRel), "utf8")).toBe("version 1");

    trashed.length = 0;
    await restoreVersion(b, v.versionRel, trash);
    expect(read(b, "doc.txt")).toBe("version 1");
    expect(trashed).toEqual([join(b, "doc.txt")]); // the replaced file stays recoverable
    await until(() => read(a, "doc.txt") === "version 1", 45_000, "the restored version to sync back");
  }, 180_000);

  it("INTERRUPTED TRANSFER: a large file resumes after the connection dies and arrives intact", async () => {
    if (!dell.m.running) await dell.m.start();
    const { a, b } = await share("big");
    await dell.m.setLimits({ maxRecvKbps: 1500, limitBandwidthInLan: true }); // loopback counts as LAN, which Syncthing does not throttle unless asked
    const data = randomBytes(16 * 1024 * 1024);
    put(a, "big.bin", data);
    put(a, "small.txt", "small");
    await until(async () => { const s = (await dell.m.summary()).folders.find((f) => f.id === "big"); return !!s && s.percent > 10 && s.percent < 90; }, 60_000, "transfer to be part-way");
    await dell.m.crash(); // killed mid-transfer, like a crash or power loss (no graceful shutdown)
    expect(existsSync(join(b, "big.bin")) ? sha(join(b, "big.bin")) : "").not.toBe(createHash("sha256").update(data).digest("hex"));

    await dell.m.start();
    await dell.m.setLimits({ maxRecvKbps: 0, limitBandwidthInLan: false });
    await until(() => existsSync(join(b, "big.bin")) && sha(join(b, "big.bin")) === createHash("sha256").update(data).digest("hex"), 120_000, "resumed transfer to finish");
    expect(read(b, "small.txt")).toBe("small");
    expect(statSync(join(b, "big.bin")).size).toBe(data.length);
  }, 300_000);

  it("RECONCILIATION: with the file watcher off, a periodic scan still finds the change", async () => {
    const { a, b } = await share("scan", { watcher: false, rescan: 3 });
    put(a, "x.txt", "one");
    await until(() => existsSync(join(b, "x.txt")), 60_000, "initial sync");
    put(a, "x.txt", "two (no watcher event)");
    await until(() => read(b, "x.txt").startsWith("two"), 60_000, "periodic scan to pick it up");
  }, 150_000);

  it("is private by default: the API is loopback-only, needs a key, and telemetry is declined", async () => {
    const cfg = await hp.m.api<{ gui: { address: string }; options: { urAccepted: number; crashReportingEnabled: boolean; autoUpgradeIntervalH: number } }>("GET", "/rest/config");
    expect(cfg.gui.address.startsWith("127.0.0.1")).toBe(true);
    expect(cfg.options.urAccepted).toBe(-1);
    expect(cfg.options.crashReportingEnabled).toBe(false);
    expect(cfg.options.autoUpgradeIntervalH).toBe(0);
    expect(hp.m.guiUrl.startsWith("http://127.0.0.1:")).toBe(true);
    const noKey = await fetch(`${hp.m.guiUrl}/rest/system/status`); // the real listener, without the API key
    expect(noKey.status).toBeGreaterThanOrEqual(400);
  });
});
