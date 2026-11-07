import { useSyncExternalStore } from "react";
import { VoiceSettings, type VoicePhase } from "@solo/shared";
import { VoiceEngine } from "./engine";

export interface HeardLine { id: number; text: string; accepted: boolean; at: number }
interface Snapshot { phase: VoicePhase; heard: HeardLine[]; error?: string; model: "idle" | "loading" | "ready" | "failed"; modelPct: number; settings: VoiceSettings }

const KEY = "solo.voice.settings";
function loadSettings(): VoiceSettings {
  try { return VoiceSettings.parse({ ...JSON.parse(localStorage.getItem(KEY) ?? "{}"), micEnabled: false }); } // mic never auto-starts
  catch { return VoiceSettings.parse({}); }
}

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
  },
  () => snap.settings,
);

export const voice = {
  engine,
  updateSettings(patch: Partial<VoiceSettings>) {
    const settings = { ...snap.settings, ...patch };
    set({ settings });
    try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* private mode etc. */ }
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
