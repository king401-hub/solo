import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PROTOCOL_VERSION, type DeviceInfo, type Envelope } from "@solo/shared";
import { DeviceStore } from "../link/store";
import type { HubLike } from "../link/hub";
import { createFiles, type FilesService } from "./service";
import { freePort } from "./syncthing";

/**
 * The Solo flow end to end with real engines: two Solo devices that already trust each other introduce their sync
 * identities over the (here simulated, in-memory) Solo link, one offers a folder, the other accepts it into a folder of
 * its own, and the real files flow. Loopback only: it does not prove NAT traversal over the internet.
 */
const BIN = resolve(__dirname, "../../../resources/syncthing/syncthing.exe");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean | Promise<boolean>, ms = 60_000, what = "condition") {
  const end = Date.now() + ms;
  while (!(await f())) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(250); }
}
const put = (root: string, rel: string, data: string) => { const p = join(root, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, data); };

/** An in-memory stand-in for the Solo link between two devices. */
class FakeHub extends EventEmitter implements HubLike {
  peer?: FakeHub;
  constructor(readonly id: string) { super(); }
  online = false;
  get onlineDeviceIds() { return this.online && this.peer ? [this.peer.id] : []; }
  send(to: string, type: Envelope["type"], payload: unknown) {
    if (!this.peer || to !== this.peer.id || !this.online) return false;
    const env = { v: PROTOCOL_VERSION, id: "m", ts: Date.now(), from: this.id, type, payload } as Envelope;
    setTimeout(() => this.peer!.emit("message", this.id, env), 5);
    return true;
  }
}
const info = (id: string, name: string): DeviceInfo => ({ deviceId: id, kind: "windows", name, appVersion: "1" });

describe.skipIf(!existsSync(BIN))("Solo file-sync flow (real engines)", () => {
  const A = { id: "a".repeat(64), name: "HP laptop" }, B = { id: "b".repeat(64), name: "Dell laptop" };
  let a: FilesService, b: FilesService, hubA: FakeHub, hubB: FakeHub, dirA: string, dirB: string;
  const ports: Record<string, number> = {};
  const trashed: string[] = [];

  beforeAll(async () => {
    dirA = mkdtempSync(join(tmpdir(), "solo-flow-a-")); dirB = mkdtempSync(join(tmpdir(), "solo-flow-b-"));
    hubA = new FakeHub(A.id); hubB = new FakeHub(B.id); hubA.peer = hubB; hubB.peer = hubA;
    const storeA = new DeviceStore(join(dirA, "devices.json")); storeA.add(info(B.id, B.name), "t");
    const storeB = new DeviceStore(join(dirB, "devices.json")); storeB.add(info(A.id, A.name), "t");
    const [pa, pb] = [await freePort(), await freePort()];
    const addresses = (st: string) => { const p = ports[st]; return p ? [`tcp://127.0.0.1:${p}`] : undefined; };
    const common = { privacy: { globalDiscovery: false, relays: false, nat: false, localDiscovery: false }, listenHost: "127.0.0.1", deviceAddresses: addresses, trash: (p: string) => { trashed.push(p); rmSync(p); }, onChange: () => {} };
    a = createFiles({ ...common, dir: dirA, binary: BIN, hub: hubA, store: storeA, selfName: () => A.name, listenPort: pa });
    b = createFiles({ ...common, dir: dirB, binary: BIN, hub: hubB, store: storeB, selfName: () => B.name, listenPort: pb });
    await Promise.all([a.setEnabled(true), b.setEnabled(true)]);
    ports[a.engine!.myId] = pa; ports[b.engine!.myId] = pb;
  }, 120_000);

  afterAll(async () => {
    await Promise.allSettled([a?.stop(), b?.stop()]);
    for (const d of [dirA, dirB]) if (d) rmSync(d, { recursive: true, force: true });
  }, 60_000);

  it("devices that already trust each other exchange sync identities automatically", async () => {
    hubA.online = hubB.online = true; // the Solo link comes up (LAN or relay)
    hubA.emit("connected", info(B.id, B.name)); hubB.emit("connected", info(A.id, A.name));
    await until(() => a.peers[B.id] === b.engine!.myId && b.peers[A.id] === a.engine!.myId, 30_000, "identities to be exchanged");
    await until(async () => (await a.state()).devices.find((d) => d.soloId === B.id)?.connected === true, 60_000, "engines to connect");
    expect((await b.state()).devices.find((d) => d.soloId === A.id)).toMatchObject({ name: A.name, connected: true });
  }, 120_000);

  it("ignores a sync identity from a device Solo does not trust", async () => {
    const stranger = "c".repeat(64);
    hubA.emit("message", stranger, { v: 1, id: "x", ts: 1, from: stranger, type: "files.device", payload: { syncthingId: "MFZWI3D-BONSGYC-YLTMRWG-C43ENR5-QXGZDMM-FZWI3DP-BONSGYY-LTMRWAD", name: "Evil" } });
    await sleep(500);
    expect(a.peers[stranger]).toBeUndefined();
  });

  it("offer a folder from one device, accept it on the other into its own path, and the real files flow", async () => {
    const pathA = join(dirA, "D", "Projects", "SchoolDom"), pathB = join(dirB, "D", "Projects", "SchoolDom");
    put(pathA, "src/App.tsx", "export const App = 1;");
    put(pathA, "node_modules/x/index.js", "dependency");
    put(pathA, "dev.sqlite", "db");
    const id = await a.addFolder({ path: pathA, label: "SchoolDom", deviceSoloIds: [B.id] });

    await until(async () => (await b.state()).pending.some((p) => p.folderId === id), 60_000, "the offer to reach the other device");
    const offer = (await b.state()).pending.find((p) => p.folderId === id)!;
    expect(offer).toMatchObject({ label: "SchoolDom", offeredBy: [A.name] }); // shown by friendly name, not id
    await b.acceptPending(id, pathB);

    await until(() => existsSync(join(pathB, "src/App.tsx")), 60_000, "file to arrive");
    expect(readFileSync(join(pathB, "src/App.tsx"), "utf8")).toBe("export const App = 1;");
    await sleep(3000);
    expect(existsSync(join(pathB, "node_modules"))).toBe(false); // default exclusions applied
    expect(existsSync(join(pathB, "dev.sqlite"))).toBe(false);

    // the user keeps working with ordinary tools on the second device; it reaches the first
    put(pathB, "src/App.tsx", "export const App = 2; // edited on the Dell");
    await until(() => readFileSync(join(pathA, "src/App.tsx"), "utf8").includes("Dell"), 60_000, "edit to come back");

    const st = (await a.state()).folders.find((f) => f.id === id)!;
    expect(st).toMatchObject({ label: "SchoolDom", path: pathA, conflicts: 0 });
    expect(st.deviceNames).toEqual([B.name]);
    expect(await a.getIgnores(id)).toContain("node_modules");
  }, 240_000);

  it("never shares a folder with a device whose sync identity is unknown", async () => {
    await expect(a.share("any", "d".repeat(64))).rejects.toThrow(/not shared its file-sync identity/);
  });
});
