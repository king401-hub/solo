import { describe, expect, it } from "vitest";

// splitForSpeech is pure, but tts.ts touches speechSynthesis only inside functions, so it imports fine under Node.
import { splitForSpeech } from "./tts";

describe("splitForSpeech", () => {
  it("splits at sentence ends and keeps the punctuation", () => {
    expect(splitForSpeech("Good morning. How can I help? I found three things!")).toEqual(["Good morning. How can I help? I found three things!"]);
    const long = Array.from({ length: 12 }, (_, i) => `This is sentence number ${i + 1} of a long reply.`).join(" ");
    const parts = splitForSpeech(long);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(240);
    expect(parts.join(" ")).toBe(long);
  });
  it("never loses words, whatever the text", () => {
    const text = "First, the build is passing; second, the conflict was kept: both versions. Third a single very long sentence without any stop marks that keeps going and going " + "and going ".repeat(40) + "until it ends";
    const parts = splitForSpeech(text);
    expect(parts.join(" ").replace(/\s+/g, " ")).toBe(text.replace(/\s+/g, " "));
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(260);
  });
  it("handles empty and whitespace-only text", () => {
    expect(splitForSpeech("")).toEqual([]);
    expect(splitForSpeech("   \n ")).toEqual([]);
  });
});
