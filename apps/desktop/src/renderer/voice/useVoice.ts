import { useSyncExternalStore } from "react";
import { PORTABLE_VOICE_KEYS, VoiceSettings, thresholdFor, type VoicePhase } from "@solo/shared";
import { VoiceEngine } from "./engine";

export interface HeardLine { id: number; text: string; accepted: boolean; at: number; owner?: boolean; score?: number }
export interface VoiceIdState { enrolled: boolean; createdAt?: number; encrypted: boolean }
export interface TestResult { score?: number; owner?: boolean; threshold: number; note?: string }
interface Snapshot {
  phase: VoicePhase; heard: HeardLine[]; error?: string;
  model: "idle" | "loading" | "ready" | "failed"; modelPct: number; settings: VoiceSettings;
  voiceId: VoiceIdState; lastTest?: TestResult;
}

const KEY = "solo.voice.settings.v2"; // v2: wake defaults changed (bare "Solo"/"Solomon" on)
function loadSettings(): VoiceSettings {
  try { return VoiceSettings.parse({ ...JSON.parse(localStorage.getItem(KEY) ?? "{}"), micEnabled: false }); } // mic never auto-starts
  catch { return VoiceSettings.parse({}); }
}

const ROW = "voice";
const portable = (s: VoiceSettings) => Object.fromEntries(PORTABLE_VOICE_KEYS.map((k) => [k, s[k]]));

let snap: Snapshot = { phase: "off", heard: [], model: "idle", modelPct: 0, settings: loadSettings(), voiceId: { enrolled: false, encrypted: false } };
const subs = new Set<() => void>();
const set = (p: Partial<Snapshot>) => { snap = { ...snap, ...p }; subs.forEach((f) => f()); };
let nextId = 1;

/** Solo repeats what it understood until the conversational AI arrives. It must never repeat its own name, or the
 *  microphone could hear "Solo" in its reply and treat it as a new wake word. */
const stripWake = (t: string) => t.replace(/\b(hey|hi|hay|okay|ok)?\s*solo(mon)?\b/gi, " ").replace(/\s+/g, " ").trim();

const engine = new VoiceEngine(
  {
    onState: (s) => set({ phase: s.phase }),
    onSubmit: (text) => { void engine.reply(`I heard: ${stripWake(text) || "you"}`); },
    onHeard: (text, accepted, info) => set({ heard: [{ id: nextId++, text, accepted, at: Date.now(), owner: info.owner, score: info.score }, ...snap.heard].slice(0, 12) }),
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

async function refreshVoiceId() {
  const st = await window.solo.voiceId.status();
  engine.setEnrolled(st.enrolled);
  set({ voiceId: { enrolled: st.enrolled, createdAt: st.createdAt, encrypted: st.encrypted } });
  return st;
}
void refreshVoiceId();

export const ENROLL_SENTENCES = [
  "Good morning, this is my voice and I am teaching Solo to recognise me.",
  "The quick brown fox jumps over the lazy dog near the old market.",
  "Please open my project folder and show me what changed yesterday.",
  "I will call my brother in Lagos later, and then send a message to my team.",
  "Hello Solo, can you hear me clearly? This is how I normally speak.",
];

async function warmModels(): Promise<boolean> {
  set({ model: "loading", modelPct: 0 });
  const off = window.solo.voice.onModelProgress((modelPct) => set({ modelPct }));
  try {
    let r = await window.solo.voice.warmup(snap.settings.asrModel);
    if (!r.ok && snap.settings.asrModel !== "fast") {
      // A bigger model that cannot be downloaded (offline, flaky network) must not leave Solo deaf: use the small one.
      const bad = snap.settings.asrModel;
      r = await window.solo.voice.warmup("fast");
      if (r.ok) set({ error: `Could not load the "${bad}" speech model, so Solo is using the fast one for now. Check your connection and switch the model in Recognition accuracy to try again.` });
    }
    if (!r.ok) { set({ model: "failed", error: `Speech model could not load: ${r.error}` }); return false; }
    if (snap.voiceId.enrolled) {
      const v = await window.solo.voiceId.warmup();
      if (!v.ok) { set({ model: "failed", error: `Voice model could not load: ${v.error}` }); return false; }
    }
    set({ model: "ready" });
    return true;
  } finally { off(); }
}

export const voice = {
  engine,
  refreshVoiceId,
  updateSettings(patch: Partial<VoiceSettings>) {
    const settings = { ...snap.settings, ...patch };
    set({ settings });
    if (patch.asrModel) set({ model: "idle" }); // the new model loads the next time the microphone is switched on
    try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* private mode etc. */ }
    // Only portable fields travel between devices; mic/device choices and the voice print stay on this PC.
    if (PORTABLE_VOICE_KEYS.some((k) => k in patch)) void window.solo.sync.set("settings", ROW, portable(settings));
  },
  async setMic(on: boolean) {
    set({ error: undefined });
    if (!on) { await engine.stop(); voice.updateSettings({ micEnabled: false }); return; }
    await refreshVoiceId();
    if (snap.model !== "ready" && !(await warmModels())) return;
    await engine.start();
    voice.updateSettings({ micEnabled: engine.phase !== "off" });
  },

  /** Record one sentence for enrolment and add it to the voice print. */
  async recordEnrollmentClip(): Promise<{ ok: boolean; count: number; reason?: string }> {
    const startedHere = engine.phase === "off";
    if (startedHere) await engine.start();
    if (engine.phase === "off") return { ok: false, count: 0, reason: snap.error ?? "The microphone could not be started." };
    try {
      const pcm = await engine.captureClip();
      return await window.solo.voiceId.addClip(pcm);
    } catch (e) {
      return { ok: false, count: (await window.solo.voiceId.status()).pending, reason: e instanceof Error ? e.message : String(e) };
    } finally { if (startedHere && !snap.settings.micEnabled) await engine.stop(); }
  },
  async finishEnrollment() {
    const r = await window.solo.voiceId.finish();
    await refreshVoiceId();
    return r;
  },
  async resetVoiceId() { await window.solo.voiceId.reset(); set({ lastTest: undefined }); await refreshVoiceId(); },

  /** "Test my voice": record a phrase and show the match score against the threshold in force. */
  async testMyVoice(): Promise<TestResult> {
    const threshold = thresholdFor(snap.settings.strictness);
    const startedHere = engine.phase === "off";
    if (startedHere) await engine.start();
    try {
      const v = await window.solo.voiceId.warmup();
      if (!v.ok) return finishTest({ threshold, note: v.error });
      const pcm = await engine.captureClip(15_000);
      const r = await window.solo.voiceId.verify(pcm, snap.settings.strictness);
      if (!r.enrolled) return finishTest({ threshold, note: "No voice print yet." });
      if (r.tooShort) return finishTest({ threshold, note: "That was too short to judge. Say a full sentence." });
      return finishTest({ threshold, score: r.score, owner: r.owner });
    } catch (e) {
      return finishTest({ threshold, note: e instanceof Error ? e.message : String(e) });
    } finally { if (startedHere && !snap.settings.micEnabled) await engine.stop(); }
  },

  addCorrection(heard: string, meant: string) {
    const h = heard.trim().toLowerCase(), m = meant.trim();
    if (!h || !m) return;
    voice.updateSettings({ corrections: [...snap.settings.corrections.filter((c) => c.heard.toLowerCase() !== h), { heard: h, meant: m }].slice(-200) });
  },
  removeCorrection(heard: string) { voice.updateSettings({ corrections: snap.settings.corrections.filter((c) => c.heard !== heard) }); },
};

function finishTest(t: TestResult): TestResult { set({ lastTest: t }); return t; }

export function useVoice(): Snapshot {
  return useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => snap);
}

// Opt-in: start listening automatically when Solo launches (e.g. hidden at Windows start-up).
void window.solo.app.getBackground().then((b) => { if (b.autoListen) void voice.setMic(true); });
