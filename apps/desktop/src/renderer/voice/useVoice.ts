import { useSyncExternalStore } from "react";
import { PORTABLE_VOICE_KEYS, VoiceSettings, type VoicePhase } from "@solo/shared";
import { VoiceEngine } from "./engine";

export interface HeardLine { id: number; text: string; accepted: boolean; at: number }
interface Snapshot { phase: VoicePhase; heard: HeardLine[]; error?: string; model: "idle" | "loading" | "ready" | "failed"; modelPct: number; settings: VoiceSettings }

const KEY = "solo.voice.settings.v2"; // v2: wake defaults changed (bare "Solo"/"Solomon" on)
function loadSettings(): VoiceSettings {
  try { return VoiceSettings.parse({ ...JSON.parse(localStorage.getItem(KEY) ?? "{}"), micEnabled: false }); } // mic never auto-starts
  catch { return VoiceSettings.parse({}); }
}

const ROW = "voice";
const portable = (s: VoiceSettings) => Object.fromEntries(PORTABLE_VOICE_KEYS.map((k) => [k, s[k]]));

let snap: Snapshot = { phase: "off", heard: [], model: "idle", modelPct: 0, settings: loadSettings() };
const subs = new Set<() => void>();
const set = (p: Partial<Snapshot>) => { snap = { ...snap, ...p }; subs.forEach((f) => f()); };
let nextId = 1;

const engine = new VoiceEngine(
  {
    onState: (s) => set({ phase: s.phase }),
    onSubmit: (text) => {
      // Phase 4 replaces this with the conversational AI. Until then Solo just confirms what it understood.
      void engine.reply(`I heard: ${text}`);
    },
    onHeard: (text, accepted) => set({ heard: [{ id: nextId++, text, accepted, at: Date.now() }, ...snap.heard].slice(0, 12) }),
    onError: (error) => set({ error }),
    onWake: () => { void window.solo.app.reveal(); },
  },
  () => snap.settings,
);

/** Merge a synced (portable) row into the local settings without touching device-specific fields. */
function applyRemote(data: Record<string, unknown> | undefined) {
  if (!data) return;
  const merged = VoiceSettings.safeParse({ ...snap.settings, ...data });
  if (merged.success) {
    set({ settings: { ...merged.data, micEnabled: snap.settings.micEnabled } });
    try { localStorage.setItem(KEY, JSON.stringify(snap.settings)); } catch { /* ignore */ }
  }
}
void window.solo.sync.get("settings", ROW).then(applyRemote);
window.solo.sync.onChanged((c) => { if (c.table === "settings" && c.rowId === ROW) applyRemote(c.data); });

export const voice = {
  engine,
  updateSettings(patch: Partial<VoiceSettings>) {
    const settings = { ...snap.settings, ...patch };
    set({ settings });
    try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* private mode etc. */ }
    // Only portable fields travel between devices; mic/device choices stay on this PC.
    if (PORTABLE_VOICE_KEYS.some((k) => k in patch)) void window.solo.sync.set("settings", ROW, portable(settings));
  },
  async setMic(on: boolean) {
    set({ error: undefined });
    if (!on) { await engine.stop(); voice.updateSettings({ micEnabled: false }); return; }
    if (snap.model !== "ready") {
      set({ model: "loading", modelPct: 0 });
      const off = window.solo.voice.onModelProgress((modelPct) => set({ modelPct }));
      const r = await window.solo.voice.warmup();
      off();
      if (!r.ok) { set({ model: "failed", error: `Speech model could not load: ${r.error}` }); return; }
      set({ model: "ready" });
    }
    await engine.start();
    voice.updateSettings({ micEnabled: engine.phase !== "off" });
  },
};

export function useVoice(): Snapshot {
  return useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => snap);
}

// Opt-in: start listening automatically when Solo launches (e.g. hidden at Windows start-up).
void window.solo.app.getBackground().then((b) => { if (b.autoListen) void voice.setMic(true); });
