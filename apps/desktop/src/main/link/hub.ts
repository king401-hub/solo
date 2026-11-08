import { EventEmitter } from "node:events";
import type { DeviceInfo, Envelope } from "@solo/shared";

/** What sync (and later the agents/orchestrator) need from "the network", whichever transport carries it. */
export interface HubLike {
  readonly onlineDeviceIds: string[];
  send(to: string, type: Envelope["type"], payload: unknown): boolean;
  on(event: "connected", cb: (d: DeviceInfo) => void): unknown;
  on(event: "message", cb: (from: string, env: Envelope) => void): unknown;
}

interface Transport {
  readonly onlineDeviceIds: string[];
  send(to: string, type: Envelope["type"], payload: unknown): boolean;
  on(event: "connected", cb: (d: DeviceInfo) => void): unknown;
  on(event: "disconnected", cb: (id: string) => void): unknown;
  on(event: "message", cb: (from: string, env: Envelope) => void): unknown;
}

export interface HubEvents {
  connected: [DeviceInfo];
  disconnected: [string];
  message: [string, Envelope];
}

/**
 * Presents the LAN link and the internet relay as one network. Sends prefer the LAN (fast, private to the network)
 * and fall back to the relay. A device counts as online while either path is up.
 */
export class Hub extends EventEmitter<HubEvents> implements HubLike {
  constructor(private lan: Transport, private relay: Transport) {
    super();
    for (const t of [lan, relay]) {
      t.on("connected", (d) => this.emit("connected", d));
      t.on("message", (from, env) => this.emit("message", from, env));
      t.on("disconnected", (id) => { if (!this.onlineDeviceIds.includes(id)) this.emit("disconnected", id); });
    }
  }

  get onlineDeviceIds(): string[] { return [...new Set([...this.lan.onlineDeviceIds, ...this.relay.onlineDeviceIds])]; }

  isOnLan(id: string) { return this.lan.onlineDeviceIds.includes(id); }
  isOnRelay(id: string) { return this.relay.onlineDeviceIds.includes(id); }

  send(to: string, type: Envelope["type"], payload: unknown): boolean {
    if (this.lan.onlineDeviceIds.includes(to) && this.lan.send(to, type, payload)) return true;
    return this.relay.send(to, type, payload);
  }
}
