import { z } from "zod";
import { matchGreeting, type GreetingKind } from "./language";

/** User-facing voice settings (persisted locally; synced to the phone later). */
export const VoiceSettings = z.object({
  micEnabled: z.boolean().default(false), // off until the user turns it on
  wakeWords: z.array(z.string().min(1)).default(["hey solo", "hey solomon"]),
  quickWord: z.boolean().default(true), // bare "Solo" / "Solomon" as a wake word (more false wakes than "Hey Solo")
  followUpSeconds: z.number().int().min(0).max(120).default(12), // keep listening after a reply without a wake word
  inputDeviceId: z.string().optional(),
  outputDeviceId: z.string().optional(),
  voiceURI: z.string().optional(), // device-specific explicit choice; overrides voiceGender on this device only
  voiceGender: z.enum(["female", "male", "any"]).default("female"), // Solo's voice, synced across devices
  speechRate: z.number().min(0.5).max(2).default(1),
  // ---- recognising the owner's voice (device-specific, never synced; the voice print itself is stored separately) ----
  onlyMyVoice: z.boolean().default(true), // once a voice print exists, other voices cannot wake or command Solo
  greetingsWake: z.boolean().default(true), // the owner's "hello" / "good morning" wakes Solo with no wake word
  allowInterrupt: z.boolean().default(true), // only the owner's voice can interrupt Solo while it is speaking
  strictness: z.number().min(0).max(1).default(0.25), // 0 = lenient ... 1 = strict. Default (threshold about 0.785) chosen from measurements: 0 of 12 other-voice clips accepted, 11 of 12 unseen owner clips, and short one-second greetings score lower than long speech
  // ---- recognition quality ----
  asrModel: z.enum(["fast", "better", "best"]).default("fast"), // speech-recognition model size (speed vs accuracy); "fast" is the one verified end to end
  corrections: z.array(z.object({ heard: z.string().max(80), meant: z.string().max(80) })).max(200).default([]), // words the user taught Solo
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
  const bare = [...SOLO_ALIASES, ...SOLOMON_ALIASES];
  return tryPrefix(names, true) ?? (opts.quickWord ? tryPrefix(bare, false) : null) ?? { matched: false, rest: "" };
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
  | { type: "utterance"; text: string; now: number; wakeAlready?: boolean; /** was it the enrolled owner? undefined = not checked or too short to judge */ owner?: boolean } // finished speech segment, transcribed
  | { type: "reply.start" }
  | { type: "reply.end"; now: number; followUpMs: number }
  | { type: "barge-in" } // user speaks over Solo
  | { type: "cancel" };

export type VoiceEffect =
  | { type: "stop-speaking" }
  | { type: "submit"; text: string } // send to the conversational/agentic system
  | { type: "prompt" } // "Hey Solo" with no request: acknowledge and listen
  | { type: "greet"; kind: GreetingKind } // the owner said hello / good morning: greet back
  | { type: "ignore" };

export const initialVoice: VoiceState = { phase: "off", followUpUntil: 0 };

/**
 * Pure transition function. Guarantees: nothing is submitted while the mic is off; ambient speech without a wake word
 * (outside the follow-up window) is dropped, never uploaded or submitted; barge-in always stops speech first.
 */
export function stepVoice(
  s: VoiceState,
  e: VoiceEvent,
  cfg: { wakeWords?: string[]; quickWord?: boolean; voiceId?: { enrolled: boolean; onlyMyVoice: boolean; greetings: boolean } } = {},
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
      const vid = cfg.voiceId;
      // With a voice print and "only my voice" on, anything that is not verifiably the owner is ignored outright: it cannot
      // wake Solo, give it a command, or continue a conversation. Audio too short to judge counts as not verified.
      if (vid?.enrolled && vid.onlyMyVoice && e.owner !== true) return same([{ type: "ignore" }]);
      const inFollowUp = e.now <= s.followUpUntil;
      const w = matchWake(e.text, cfg);
      // The owner's greeting works without any wake word ("good morning"); never for an unverified voice.
      const g = !w.matched && vid?.enrolled && vid.greetings && e.owner === true ? matchGreeting(e.text) : null;
      const text = w.matched ? w.rest : g ? g.rest : e.text.trim();
      if (!w.matched && !g && !inFollowUp && !e.wakeAlready && s.phase !== "listening") {
        return same([{ type: "ignore" }]); // ambient speech: drop
      }
      const stop: VoiceEffect[] = s.phase === "speaking" ? [{ type: "stop-speaking" }] : [];
      if (!text) {
        if (g) return { state: { ...s, phase: "thinking" }, effects: [...stop, { type: "greet", kind: g.kind }] };
        return { state: { ...s, phase: "listening" }, effects: [...stop, { type: "prompt" }] };
      }
      return { state: { ...s, phase: "thinking" }, effects: [...stop, { type: "submit", text }] };
    }
  }
}

// ---- Voice choice ------------------------------------------------------------------------------

/** Names of common female system voices (Windows, Android/Google, macOS). Used only to pick a default. */
const FEMALE_NAMES = ["zira", "hazel", "susan", "aria", "jenny", "michelle", "emma", "sonia", "libby", "samantha", "eva", "heera", "catherine", "linda", "hedda", "helena", "female", "karen", "moira", "tessa", "victoria"];
const MALE_NAMES = ["david", "mark", "george", "guy", "ryan", "james", "richard", "sean", "male", "daniel", "alex", "fred"];

export interface VoiceInfoLike { name: string; lang: string; voiceURI: string }

/** The voices that portable settings are about: those that sync between devices. */
export const PORTABLE_VOICE_KEYS = ["wakeWords", "quickWord", "followUpSeconds", "speechRate", "voiceGender"] as const;
export type PortableVoice = Pick<VoiceSettings, (typeof PORTABLE_VOICE_KEYS)[number]>;

/** Pick the voice for the requested gender, preferring English. Returns undefined to use the system default. */
export function pickVoice<T extends VoiceInfoLike>(voices: T[], gender: VoiceSettings["voiceGender"], explicitURI?: string): T | undefined {
  const explicit = explicitURI ? voices.find((v) => v.voiceURI === explicitURI) : undefined;
  if (explicit) return explicit;
  if (gender === "any") return undefined;
  const names = gender === "female" ? FEMALE_NAMES : MALE_NAMES;
  const other = gender === "female" ? MALE_NAMES : FEMALE_NAMES;
  const matches = (v: T, list: string[]) => list.some((n) => v.name.toLowerCase().includes(n));
  const en = voices.filter((v) => v.lang.toLowerCase().startsWith("en"));
  const pool = en.length ? en : voices;
  const hit = pool.find((v) => matches(v, names) && !matches(v, other));
  if (hit) return hit;
  return voices.find((v) => matches(v, names) && !matches(v, other));
}

// ---- Microphone policy while Solo talks -------------------------------------------------------------------------

export type MicPolicy = "listen" | "ignore" | "watch-interrupt";

/**
 * Decides what to do with microphone audio. Solo must never treat its own voice (coming out of the laptop speakers) as
 * the user: while it speaks, and briefly after, the microphone is ignored. The only exception is an enrolled owner who
 * allowed interruption: then sustained speech is checked against the owner's voice print (watch-interrupt), so a person
 * can stop Solo but Solo's own voice, a TV or a visitor cannot. Without a voice print there is no way to tell the
 * owner from Solo's own voice, so nothing can interrupt it by sound.
 */
export function micPolicy(o: { capturing: boolean; speaking: boolean; now: number; muteUntil: number; enrolled: boolean; allowInterrupt: boolean }): MicPolicy {
  if (o.capturing) return "listen"; // enrolment recording: Solo is silent then
  if (!o.speaking && o.now >= o.muteUntil) return "listen";
  return o.speaking && o.enrolled && o.allowInterrupt ? "watch-interrupt" : "ignore";
}
