import { describe, expect, it } from "vitest";
import { Segmenter, initialVoice, matchWake, resample, stepVoice, type VoiceEvent, type VoiceState } from "./index";

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
  it("bare Solo only with quick activation", () => {
    expect(matchWake("solo open chrome").matched).toBe(false);
    expect(matchWake("solo open chrome", { quickWord: true })).toEqual({ matched: true, rest: "open chrome" });
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
