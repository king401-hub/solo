import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VoiceId } from "./voiceId";
import type { Speaker } from "./speaker";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "solo-vid-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/**
 * A stand-in speaker model: the first sample of the "audio" names the person (0.1 = Ann, 0.2 = Bob) and the rest adds
 * small per-clip variation, so the logic around the model can be tested without downloading it.
 */
function fakeSpeaker(): Speaker {
  return {
    async warmup() {},
    async embed(pcm) {
      if (pcm.length < 16000) return undefined;
      const who = Math.round(pcm[0]! * 10);
      const v = new Float32Array(16).fill(0.05);
      v[who] = 1;
      for (let i = 0; i < 16; i++) v[i]! += (pcm[1 + i]! ?? 0) * 0.3;
      let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n);
      return v.map((x) => x / n);
    },
  };
}
const audio = (who: number, seconds = 4, seed = 0, level = 0.2) => {
  const a = new Float32Array(Math.round(seconds * 16000));
  for (let i = 0; i < a.length; i++) a[i] = Math.sin(i / 7 + seed) * level;
  a[0] = who / 10;
  for (let i = 1; i <= 16; i++) a[i] = ((Math.sin(seed * 12.9898 + i * 78.233) * 43758.5453) % 1) * 0.5;
  return a;
};
const make = (file: string, extra: Partial<ConstructorParameters<typeof VoiceId>[0]> = {}) => new VoiceId({ file, speaker: fakeSpeaker(), model: "m1", ...extra });

describe("VoiceId enrolment", () => {
  it("rejects recordings that are too short or too quiet, with a helpful reason", async () => {
    const v = make(join(tmp(), "vp.bin"));
    expect(await v.addClip(audio(1, 1))).toMatchObject({ ok: false, count: 0, reason: expect.stringMatching(/too short/) });
    expect(await v.addClip(audio(1, 4, 0, 0.001))).toMatchObject({ ok: false, count: 0, reason: expect.stringMatching(/too quiet/) });
    expect(v.status().pending).toBe(0);
  });

  it("needs enough recordings, then enrols and recognises the owner but not someone else", async () => {
    const v = make(join(tmp(), "vp.bin"));
    expect(v.status()).toMatchObject({ enrolled: false, needed: 4 });
    for (let i = 0; i < 3; i++) await v.addClip(audio(1, 4, i));
    expect(v.finishEnrollment().ok).toBe(false); // only 3
    await v.addClip(audio(1, 4, 3));
    await v.addClip(audio(1, 4, 4));
    expect(v.finishEnrollment().ok).toBe(true);
    expect(v.status().enrolled).toBe(true);

    const mine = await v.verify(audio(1, 4, 77), 0.5);
    const other = await v.verify(audio(2, 4, 78), 0.5);
    expect(mine).toMatchObject({ enrolled: true, owner: true });
    expect(other).toMatchObject({ enrolled: true, owner: false });
  });

  it("refuses an enrolment where a different person spoke some of the recordings", async () => {
    const v = make(join(tmp(), "vp.bin"));
    for (const [who, seed] of [[1, 0], [1, 1], [2, 2], [1, 3], [2, 4]] as const) await v.addClip(audio(who, 4, seed));
    const r = v.finishEnrollment();
    expect(r.ok).toBe(false);
    expect(r.quality.reason).toMatch(/alike/);
    expect(v.status().enrolled).toBe(false);
  });

  it("audio too short to judge is reported as such, never guessed", async () => {
    const v = make(join(tmp(), "vp.bin"));
    for (let i = 0; i < 4; i++) await v.addClip(audio(1, 4, i));
    v.finishEnrollment();
    expect(await v.verify(audio(1, 0.4), 0.5)).toMatchObject({ enrolled: true, tooShort: true });
  });

  it("with no voice print, verification says so", async () => {
    expect(await make(join(tmp(), "vp.bin")).verify(audio(1), 0.5)).toEqual({ enrolled: false });
  });
});

describe("VoiceId storage", () => {
  const xor = (b: Buffer) => Buffer.from(b.map((x) => x ^ 0x5a));
  const enc = { encrypt: (t: string) => xor(Buffer.from(t, "utf8")), decrypt: (b: Buffer) => xor(b).toString("utf8") };

  async function enrolled(file: string, extra = {}) {
    const v = make(file, extra);
    for (let i = 0; i < 5; i++) await v.addClip(audio(1, 4, i));
    expect(v.finishEnrollment().ok).toBe(true);
    return v;
  }

  it("is stored encrypted (no readable numbers in the file) and survives a restart", async () => {
    const file = join(tmp(), "vp.bin");
    await enrolled(file, enc);
    const raw = readFileSync(file);
    expect(raw.toString("utf8")).not.toContain("centroid");
    const again = make(file, enc);
    expect(again.status()).toMatchObject({ enrolled: true, encrypted: true });
    expect(await again.verify(audio(1, 4, 50), 0.5)).toMatchObject({ owner: true });
  });

  it("falls back to plain storage when the OS cannot encrypt, and says so", async () => {
    const file = join(tmp(), "vp.bin");
    const v = await enrolled(file, { encrypt: () => null });
    expect(v.status().encrypted).toBe(false);
    expect(readFileSync(file, "utf8")).toContain("centroid"); // honest: this is why the UI warns
  });

  it("never stores audio, only vectors", async () => {
    const file = join(tmp(), "vp.bin");
    await enrolled(file);
    const text = readFileSync(file, "utf8");
    const parsed = JSON.parse(text);
    expect(Object.keys(parsed).sort()).toEqual(["centroid", "clips", "createdAt", "model", "v"]);
    expect(text.length).toBeLessThan(20_000); // a few hundred numbers, not seconds of audio
  });

  it("ignores a print from another model, a corrupt file, or a file it cannot decrypt", async () => {
    const file = join(tmp(), "vp.bin");
    await enrolled(file);
    expect(new VoiceId({ file, speaker: fakeSpeaker(), model: "other-model" }).status().enrolled).toBe(false);
    writeFileSync(file, "{ not json");
    expect(make(file).status().enrolled).toBe(false);
    const f2 = join(tmp(), "vp2.bin");
    await enrolled(f2, enc);
    expect(make(f2, { decrypt: () => null }).status().enrolled).toBe(false);
  });

  it("reset deletes the voice print from disk and from memory", async () => {
    const file = join(tmp(), "vp.bin");
    const v = await enrolled(file);
    expect(existsSync(file)).toBe(true);
    v.reset();
    expect(existsSync(file)).toBe(false);
    expect(v.status().enrolled).toBe(false);
    expect(await v.verify(audio(1), 0.5)).toEqual({ enrolled: false });
  });
});
