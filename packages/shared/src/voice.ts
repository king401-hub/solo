import { z } from "zod";

/** User-facing voice settings (persisted locally; synced to the phone later). */
export const VoiceSettings = z.object({
  micEnabled: z.boolean().default(false), // off until the user turns it on
  wakeWords: z.array(z.string().min(1)).default(["hey solo", "hey solomon"]),
  quickWord: z.boolean().default(false), // bare "Solo" as a wake word (more false positives)
  followUpSeconds: z.number().int().min(0).max(120).default(12), // keep listening after a reply without a wake word
  inputDeviceId: z.string().optional(),
  outputDeviceId: z.string().optional(),
  voiceURI: z.string().optional(),
  speechRate: z.number().min(0.5).max(2).default(1),
});
export type VoiceSettings = z.infer<typeof VoiceSettings>;

// ---- Wake phrase matching -------------------------------------------------------------------

const norm = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

/** Speech recognisers often hear "solo" as these; keep the list small to limit false wakes. */
const SOLO_ALIASES = ["solo", "sollo", "so low", "so lo", "soloh"];
const SOLOMON_ALIASES = ["solomon", "salomon", "soloman", "solomun"];
const HEY_ALIASES = ["hey", "hay", "hi", "hei", "okay", "ok"];

export interface WakeMatch {
  matched: boolean;
  /** What the user said after the wake phrase (may be empty: "Hey Solo" alone). */
  rest: string;
}

/**
 * Detects a wake phrase at the START of a transcript. Wake words must lead the utterance so that a sentence merely
 * mentioning Solo ("I told Solo yesterday") does not trigger.
 */
export function matchWake(transcript: string, opts: { wakeWords?: string[]; quickWord?: boolean } = {}): WakeMatch {
  const t = norm(transcript);
  if (!t) return { matched: false, rest: "" };
  const words = (opts.wakeWords ?? ["hey solo", "hey solomon"]).map(norm);
  const wantsSolo = words.some((w) => w.endsWith("solo")) || false;
  const wantsSolomon = words.some((w) => w.endsWith("solomon"));
  const names = [...(wantsSolo ? SOLO_ALIASES : []), ...(wantsSolomon ? SOLOMON_ALIASES : [])];
  // exact custom wake words first
  for (const w of words) if (t === w || t.startsWith(w + " ")) return { matched: true, rest: t.slice(w.length).trim() };
  const tryPrefix = (prefixes: string[], needHey: boolean): WakeMatch | null => {
    for (const h of needHey ? HEY_ALIASES : [""]) {
      for (const n of prefixes) {
        const p = h ? `${h} ${n}` : n;
        if (t === p || t.startsWith(p + " ")) return { matched: true, rest: t.slice(p.length).trim() };
      }
    }
    return null;
  };
  return tryPrefix(names, true) ?? (opts.quickWord ? tryPrefix(SOLO_ALIASES, false) : null) ?? { matched: false, rest: "" };
}

// ---- Voice state machine ---------------------------------------------------------------------

export type VoicePhase = "off" | "idle" | "listening" | "thinking" | "speaking";

export interface VoiceState {
  phase: VoicePhase;
  /** Epoch ms until which speech needs no wake word (conversation continuation). */
  followUpUntil: number;
}

export type VoiceEvent =
  | { type: "mic.on" }
  | { type: "mic.off" }
  | { type: "wake"; now: number } // wake phrase heard (utterance may or may not carry a request)
  | { type: "utterance"; text: string; now: number; wakeAlready?: boolean } // finished speech segment, transcribed
  | { type: "reply.start" }
  | { type: "reply.end"; now: number; followUpMs: number }
  | { type: "barge-in" } // user speaks over Solo
  | { type: "cancel" };

export type VoiceEffect =
  | { type: "stop-speaking" }
  | { type: "submit"; text: string } // send to the conversational/agentic system
  | { type: "prompt" } // "Hey Solo" with no request: acknowledge and listen
  | { type: "ignore" };

export const initialVoice: VoiceState = { phase: "off", followUpUntil: 0 };

/**
 * Pure transition function. Guarantees: nothing is submitted while the mic is off; ambient speech without a wake word
 * (outside the follow-up window) is dropped, never uploaded or submitted; barge-in always stops speech first.
 */
export function stepVoice(
  s: VoiceState,
  e: VoiceEvent,
  cfg: { wakeWords?: string[]; quickWord?: boolean } = {},
): { state: VoiceState; effects: VoiceEffect[] } {
  const same = (effects: VoiceEffect[] = []) => ({ state: s, effects });
  switch (e.type) {
    case "mic.on":
      return s.phase === "off" ? { state: { ...s, phase: "idle" }, effects: [] } : same();
    case "mic.off":
      return { state: { phase: "off", followUpUntil: 0 }, effects: s.phase === "speaking" ? [{ type: "stop-speaking" }] : [] };
    case "cancel":
      if (s.phase === "off") return same();
      return { state: { ...s, phase: "idle" }, effects: s.phase === "speaking" ? [{ type: "stop-speaking" }] : [] };
    case "barge-in":
      return s.phase === "speaking" ? { state: { ...s, phase: "listening" }, effects: [{ type: "stop-speaking" }] } : same();
    case "reply.start":
      return s.phase === "off" ? same() : { state: { ...s, phase: "speaking" }, effects: [] };
    case "reply.end":
      return s.phase === "off"
        ? same()
        : { state: { phase: "idle", followUpUntil: e.followUpMs > 0 ? e.now + e.followUpMs : 0 }, effects: [] };
    case "wake":
      return s.phase === "off" ? same() : { state: { ...s, phase: "listening" }, effects: s.phase === "speaking" ? [{ type: "stop-speaking" }] : [] };
    case "utterance": {
      if (s.phase === "off") return same([{ type: "ignore" }]);
      const inFollowUp = e.now <= s.followUpUntil;
      const w = matchWake(e.text, cfg);
      const text = w.matched ? w.rest : e.text.trim();
      if (!w.matched && !inFollowUp && !e.wakeAlready && s.phase !== "listening") {
        return same([{ type: "ignore" }]); // ambient speech: drop
      }
      const stop: VoiceEffect[] = s.phase === "speaking" ? [{ type: "stop-speaking" }] : [];
      if (!text) return { state: { ...s, phase: "listening" }, effects: [...stop, { type: "prompt" }] };
      return { state: { ...s, phase: "thinking" }, effects: [...stop, { type: "submit", text }] };
    }
  }
}
