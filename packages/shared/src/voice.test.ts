import { describe, expect, it } from "vitest";
import { Segmenter, VoiceSettings, initialVoice, matchWake, micPolicy, resample, stepVoice, type VoiceEvent, type VoiceState } from "./index";

describe("matchWake", () => {
  it("matches both wake words and returns the request", () => {
    expect(matchWake("Hey Solo, open Chrome")).toEqual({ matched: true, rest: "open chrome" });
    expect(matchWake("hey solomon what's the time")).toEqual({ matched: true, rest: "what s the time" });
    expect(matchWake("Hey Solo")).toEqual({ matched: true, rest: "" });
  });
  it("tolerates common mis-hearings", () => {
    expect(matchWake("hay solo let's continue").matched).toBe(true);
    expect(matchWake("hey so low open vs code").matched).toBe(true);
    expect(matchWake("hi salomon").matched).toBe(true);
  });
  it("does not fire on sentences that merely mention Solo or on ambient talk", () => {
    expect(matchWake("I told Solo yesterday").matched).toBe(false);
    expect(matchWake("play some solo guitar").matched).toBe(false);
    expect(matchWake("hello there everyone").matched).toBe(false);
    expect(matchWake("").matched).toBe(false);
  });
  it("bare Solo / Solomon only with quick activation", () => {
    expect(matchWake("solo open chrome").matched).toBe(false);
    expect(matchWake("solo open chrome", { quickWord: true })).toEqual({ matched: true, rest: "open chrome" });
    expect(matchWake("Solomon, what time is it", { quickWord: true })).toEqual({ matched: true, rest: "what time is it" });
    expect(matchWake("Solo.", { quickWord: true })).toEqual({ matched: true, rest: "" });
  });
  it("Hi Solo / Hi Solomon wake like Hey", () => {
    expect(matchWake("Hi Solo, good morning")).toEqual({ matched: true, rest: "good morning" });
    expect(matchWake("hi solomon")).toEqual({ matched: true, rest: "" });
  });
  it("a bare Hi or a mid-sentence Solo does not wake", () => {
    expect(matchWake("Hi", { quickWord: true }).matched).toBe(false);
    expect(matchWake("hi everyone", { quickWord: true }).matched).toBe(false);
    expect(matchWake("I think solo is great", { quickWord: true }).matched).toBe(false);
  });
  it("quick activation is on by default in settings", () => {
    expect(VoiceSettings.parse({}).quickWord).toBe(true);
  });
});

const run = (events: VoiceEvent[], start: VoiceState = initialVoice) => {
  let s = start; const effects: string[] = [];
  for (const e of events) { const r = stepVoice(s, e); s = r.state; effects.push(...r.effects.map((x) => x.type === "submit" ? `submit:${x.text}` : x.type)); }
  return { s, effects };
};

describe("voice state machine", () => {
  it("submits nothing while the mic is off", () => {
    expect(run([{ type: "utterance", text: "hey solo open chrome", now: 1 }]).effects).toEqual(["ignore"]);
    expect(run([{ type: "wake", now: 1 }]).s.phase).toBe("off");
  });
  it("wake word + request is submitted", () => {
    const r = run([{ type: "mic.on" }, { type: "utterance", text: "Hey Solo open chrome", now: 1 }]);
    expect(r.effects).toEqual(["submit:open chrome"]);
    expect(r.s.phase).toBe("thinking");
  });
  it("ambient speech without wake word is dropped", () => {
    const r = run([{ type: "mic.on" }, { type: "utterance", text: "what a lovely day", now: 1 }]);
    expect(r.effects).toEqual(["ignore"]);
    expect(r.s.phase).toBe("idle");
  });
  it("'Hey Solo' alone prompts, then the next utterance needs no wake word", () => {
    const r = run([{ type: "mic.on" }, { type: "utterance", text: "hey solo", now: 1 }, { type: "utterance", text: "what is two plus two", now: 2 }]);
    expect(r.effects).toEqual(["prompt", "submit:what is two plus two"]);
  });
  it("follow-up window allows continuing without the wake word, then expires", () => {
    const base: VoiceEvent[] = [{ type: "mic.on" }, { type: "utterance", text: "hey solo hello", now: 1 }, { type: "reply.start" }, { type: "reply.end", now: 100, followUpMs: 1000 }];
    expect(run([...base, { type: "utterance", text: "and then?", now: 500 }]).effects.at(-1)).toBe("submit:and then?");
    expect(run([...base, { type: "utterance", text: "and then?", now: 5000 }]).effects.at(-1)).toBe("ignore");
  });
  it("barge-in stops speech and listens", () => {
    const r = run([{ type: "mic.on" }, { type: "reply.start" }, { type: "barge-in" }]);
    expect(r.effects).toEqual(["stop-speaking"]);
    expect(r.s.phase).toBe("listening");
  });
  it("wake while speaking interrupts", () => {
    const r = run([{ type: "mic.on" }, { type: "reply.start" }, { type: "utterance", text: "hey solo stop", now: 5 }]);
    expect(r.effects).toEqual(["stop-speaking", "submit:stop"]);
  });
  it("mic off silences speech and clears follow-up", () => {
    const r = run([{ type: "mic.on" }, { type: "reply.start" }, { type: "mic.off" }]);
    expect(r.effects).toEqual(["stop-speaking"]);
    expect(r.s).toEqual({ phase: "off", followUpUntil: 0 });
  });
});

describe("Segmenter / resample", () => {
  const sr = 16000, frameLen = 320; // 20 ms
  const tone = (amp: number) => Float32Array.from({ length: frameLen }, (_, i) => amp * Math.sin(i / 3));
  const feed = (seg: Segmenter, amp: number, ms: number) => {
    const out: Float32Array[] = [];
    for (let i = 0; i < ms / 20; i++) { const r = seg.push(tone(amp)); if (r) out.push(r); }
    return out;
  };
  it("emits one utterance after speech then silence, with pre-roll", () => {
    const seg = new Segmenter({ sampleRate: sr });
    expect(feed(seg, 0.001, 1000)).toHaveLength(0);
    expect(feed(seg, 0.3, 600)).toHaveLength(0);
    const out = feed(seg, 0.001, 900);
    expect(out).toHaveLength(1);
    const ms = (out[0]!.length / sr) * 1000;
    expect(ms).toBeGreaterThan(600 + 250);
    expect(ms).toBeLessThan(600 + 300 + 800 + 100);
  });
  it("silence and short blips produce nothing", () => {
    const seg = new Segmenter({ sampleRate: sr });
    expect(feed(seg, 0.001, 3000)).toHaveLength(0);
    expect(feed(seg, 0.3, 100)).toHaveLength(0);
    expect(feed(seg, 0.001, 1000)).toHaveLength(0);
  });
  it("caps very long speech", () => {
    const seg = new Segmenter({ sampleRate: sr, maxUtteranceMs: 2000 });
    expect(feed(seg, 0.3, 2500).length).toBeGreaterThanOrEqual(1);
  });
  it("resamples 48k to 16k by length", () => {
    expect(resample(new Float32Array(4800), 48000, 16000)).toHaveLength(1600);
    const x = new Float32Array(10);
    expect(resample(x, 16000, 16000)).toBe(x);
  });
});

describe("owner's voice (voice print)", () => {
  const vid = { enrolled: true, onlyMyVoice: true, greetings: true };
  const step = (state: VoiceState, e: VoiceEvent, cfg: Parameters<typeof stepVoice>[2] = { voiceId: vid }) => stepVoice(state, e, cfg);
  const on: VoiceState = { phase: "idle", followUpUntil: 0 };

  it("the owner's greeting wakes Solo with no wake word", () => {
    const r = step(on, { type: "utterance", text: "Good morning", now: 1, owner: true });
    expect(r.effects).toEqual([{ type: "greet", kind: "morning" }]);
    expect(r.state.phase).toBe("thinking");
    expect(step(on, { type: "utterance", text: "hello", now: 1, owner: true }).effects).toEqual([{ type: "greet", kind: "hello" }]);
    expect(step(on, { type: "utterance", text: "how far", now: 1, owner: true }).effects).toEqual([{ type: "greet", kind: "howfar" }]);
  });
  it("a greeting followed by a request submits the request", () => {
    expect(step(on, { type: "utterance", text: "good morning open chrome", now: 1, owner: true }).effects).toEqual([{ type: "submit", text: "open chrome" }]);
  });
  it("someone else saying hello or even the wake phrase is ignored when only-my-voice is on", () => {
    for (const text of ["good morning", "hello", "hey solo open chrome", "solo what time is it"]) {
      expect(step(on, { type: "utterance", text, now: 1, owner: false }).effects, text).toEqual([{ type: "ignore" }]);
    }
  });
  it("audio too short to verify counts as not the owner (fails safe)", () => {
    expect(step(on, { type: "utterance", text: "hey solo hello", now: 1 }).effects).toEqual([{ type: "ignore" }]);
  });
  it("follow-up conversation also needs the owner's voice", () => {
    const f: VoiceState = { phase: "idle", followUpUntil: 5000 };
    expect(step(f, { type: "utterance", text: "and then what", now: 100, owner: true }).effects).toEqual([{ type: "submit", text: "and then what" }]);
    expect(step(f, { type: "utterance", text: "and then what", now: 100, owner: false }).effects).toEqual([{ type: "ignore" }]);
  });
  it("a greeting aimed at someone else is not taken, even from the owner", () => {
    expect(step(on, { type: "utterance", text: "good morning everyone", now: 1, owner: true }).effects).toEqual([{ type: "ignore" }]);
    expect(step(on, { type: "utterance", text: "hi mum", now: 1, owner: true }).effects).toEqual([{ type: "ignore" }]);
  });
  it("greetings can be switched off while the wake phrase still works for the owner", () => {
    const cfg = { voiceId: { ...vid, greetings: false } };
    expect(step(on, { type: "utterance", text: "good morning", now: 1, owner: true }, cfg).effects).toEqual([{ type: "ignore" }]);
    expect(step(on, { type: "utterance", text: "hey solo open chrome", now: 1, owner: true }, cfg).effects).toEqual([{ type: "submit", text: "open chrome" }]);
  });
  it("without a voice print nothing changes: wake phrase works for anyone, bare greetings do nothing", () => {
    expect(stepVoice(on, { type: "utterance", text: "hey solo open chrome", now: 1 }).effects).toEqual([{ type: "submit", text: "open chrome" }]);
    expect(stepVoice(on, { type: "utterance", text: "good morning", now: 1 }).effects).toEqual([{ type: "ignore" }]);
  });
  it("only-my-voice can be turned off: the owner check then only enables greetings", () => {
    const cfg = { voiceId: { ...vid, onlyMyVoice: false } };
    expect(step(on, { type: "utterance", text: "hey solo open chrome", now: 1, owner: false }, cfg).effects).toEqual([{ type: "submit", text: "open chrome" }]);
    expect(step(on, { type: "utterance", text: "good morning", now: 1, owner: false }, cfg).effects).toEqual([{ type: "ignore" }]);
  });
});

describe("micPolicy (Solo never hears itself)", () => {
  const base = { capturing: false, speaking: false, now: 1000, muteUntil: 0, enrolled: false, allowInterrupt: true };
  it("listens normally when Solo is quiet", () => expect(micPolicy(base)).toBe("listen"));
  it("ignores the microphone while Solo speaks when no voice print exists, so its own echo cannot cut it off", () => {
    expect(micPolicy({ ...base, speaking: true })).toBe("ignore");
    expect(micPolicy({ ...base, speaking: true, allowInterrupt: true })).toBe("ignore");
  });
  it("keeps ignoring for a short tail after speech ends", () => {
    expect(micPolicy({ ...base, now: 1000, muteUntil: 1500 })).toBe("ignore");
    expect(micPolicy({ ...base, now: 1500, muteUntil: 1500 })).toBe("listen");
  });
  it("lets only a verified owner interrupt: watch (do not act) while speaking, and only if allowed", () => {
    expect(micPolicy({ ...base, speaking: true, enrolled: true })).toBe("watch-interrupt");
    expect(micPolicy({ ...base, speaking: true, enrolled: true, allowInterrupt: false })).toBe("ignore");
  });
  it("the tail after speech never watches for interruptions (nothing is playing)", () => {
    expect(micPolicy({ ...base, enrolled: true, muteUntil: 2000 })).toBe("ignore");
  });
  it("enrolment recording always listens", () => {
    expect(micPolicy({ ...base, capturing: true, speaking: true })).toBe("listen");
  });
});
