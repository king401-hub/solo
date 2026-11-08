import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { VoiceSettings, thresholdFor } from "@solo/shared";
import { createSpeaker } from "./speaker";
import { VoiceId } from "./voiceId";

/**
 * Real speaker model on real audio. Opt-in (needs the ~100 MB model and sample WAVs):
 *   SOLO_VOICES_DIR=<dir with david-N-rR.wav / zira-N-rR.wav, 16 kHz mono 16-bit> npx vitest run voiceId.integration
 *
 * IMPORTANT: the two "people" are the Windows text-to-speech voices David and Zira. Synthetic voices are a poor stand-in
 * for people (the model is trained on human speech), so these numbers show the mechanics work and give a rough
 * calibration, NOT how accurate it will be for a real person. Real-voice accuracy is unmeasured.
 */
const dir = process.env["SOLO_VOICES_DIR"];
const wav = (f: string) => { const b = readFileSync(join(dir!, f)); const i = b.indexOf("data"); const pcm = new Int16Array(b.buffer.slice(b.byteOffset + i + 8, b.byteOffset + b.length - ((b.length - i - 8) % 2))); return Float32Array.from(pcm, (v) => v / 32768); };
function noisy(a: Float32Array, snrDb: number): Float32Array {
  const p = a.reduce((s, x) => s + x * x, 0) / a.length;
  const sigma = Math.sqrt(p / 10 ** (snrDb / 10));
  let s = 12345; const rnd = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
  return a.map((x) => x + sigma * Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd()));
}

describe.skipIf(!dir || !existsSync(join(dir ?? "", "david-0-r0.wav")))("owner recognition with a real speaker model", () => {
  it("enrolls one voice and tells it apart from another; reports the measured error rates", async () => {
    const speaker = createSpeaker({ cacheDir: join(homedir(), ".solo-test-models") });
    const d = mkdtempSync(join(tmpdir(), "solo-vid-real-"));
    try {
      const vid = new VoiceId({ file: join(d, "vp.bin"), speaker, model: "Xenova/wavlm-base-plus-sv" });
      vid.startEnrollment();
      for (const n of [0, 1, 2, 3, 4]) expect((await vid.addClip(wav(`david-${n}-r0.wav`))).ok).toBe(true);
      const fin = vid.finishEnrollment();
      expect(fin.ok).toBe(true);
      console.log("RESULT enrolment agreement min/mean", fin.quality.minAgreement.toFixed(3), fin.quality.meanAgreement.toFixed(3));

      const strictness = VoiceSettings.parse({}).strictness; // the app default
      const threshold = thresholdFor(strictness);
      const scoreOf = async (f: string, transform?: (a: Float32Array) => Float32Array) => {
        const a = wav(f); const r = await vid.verify(transform ? transform(a) : a, strictness);
        return r.enrolled && !r.tooShort ? r.score : NaN;
      };
      // Fair test: sentences the owner was NOT enrolled on, at everyday speed variations (about -10% .. +10..20%).
      const rates = ["r0", "r1", "r-1"];
      const genuineFiles = [0, 1, 2, 3].flatMap((n) => rates.map((r) => `david-n${n}-${r}.wav`));
      const impostorFiles = [0, 1, 2, 3].flatMap((n) => rates.map((r) => `zira-n${n}-${r}.wav`));
      // Stress test: speech at roughly 1.7x normal speed (far more than a person varies).
      const stressG = ["david-0-r3.wav", "david-1-r3.wav", "david-2-r3.wav", "david-3-r3.wav", "david-4-r3.wav", "david-5-r3.wav"];
      const stressI = ["zira-0-r3.wav", "zira-1-r3.wav", "zira-2-r3.wav", "zira-3-r3.wav", "zira-4-r3.wav", "zira-5-r3.wav", "zira-0-r0.wav", "zira-1-r0.wav", "zira-2-r0.wav", "zira-3-r0.wav", "zira-4-r0.wav", "zira-5-r0.wav"];
      const genuine = await Promise.all(genuineFiles.map((f) => scoreOf(f)));
      const impostor = await Promise.all(impostorFiles.map((f) => scoreOf(f)));
      const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
      const accepted = (xs: number[]) => xs.filter((x) => x >= threshold).length;
      console.log(`RESULT threshold ${threshold.toFixed(3)} (strictness ${strictness})`);
      console.log(`RESULT genuine  accepted ${accepted(genuine)}/${genuine.length} mean ${mean(genuine).toFixed(3)} scores ${genuine.map((x) => x.toFixed(2)).join(" ")}`);
      console.log(`RESULT impostor accepted ${accepted(impostor)}/${impostor.length} mean ${mean(impostor).toFixed(3)} scores ${impostor.map((x) => x.toFixed(2)).join(" ")}`);
      const sg = await Promise.all(stressG.map((f) => scoreOf(f))), si = await Promise.all(stressI.map((f) => scoreOf(f)));
      console.log(`RESULT STRESS (very fast speech) owner accepted ${accepted(sg)}/${sg.length} mean ${mean(sg).toFixed(2)} | other accepted ${accepted(si)}/${si.length} mean ${mean(si).toFixed(2)}`);
      for (const t of [0.74, 0.78, 0.82, 0.86, 0.9]) console.log(`RESULT at threshold ${t}: owner accepted ${genuine.filter((x) => x >= t).length}/${genuine.length}, other accepted ${impostor.filter((x) => x >= t).length}/${impostor.length}`);

      // What the mechanics must deliver on this data (measured limits, not a promise for real voices).
      expect(accepted(genuine) / genuine.length).toBeGreaterThanOrEqual(0.7);
      expect(accepted(impostor) / impostor.length).toBeLessThanOrEqual(0.25);
      expect(mean(genuine) - mean(impostor)).toBeGreaterThan(0.25);
      expect(accepted(sg)).toBeGreaterThanOrEqual(5); // enrolment augmentation makes very fast speech still match

      // Short greeting-length clips (about a second): "Hello." "Good morning." "Hi there."
      const shortG = await Promise.all(["david-6-r0.wav", "david-7-r0.wav", "david-8-r0.wav"].map((f) => scoreOf(f)));
      const shortI = await Promise.all(["zira-6-r0.wav", "zira-7-r0.wav", "zira-8-r0.wav"].map((f) => scoreOf(f)));
      console.log(`RESULT short clips: owner ${shortG.map((x) => x.toFixed(2)).join(" ")} accepted ${accepted(shortG)}/3 | other ${shortI.map((x) => x.toFixed(2)).join(" ")} accepted ${accepted(shortI)}/3`);
      expect(accepted(shortI)).toBe(0);

      // Noise: how the owner's score degrades as the room gets noisy.
      for (const snr of [30, 20, 10, 5]) {
        const g = await Promise.all(genuineFiles.filter((f) => f.endsWith("-r0.wav")).map((f) => scoreOf(f, (a) => noisy(a, snr))));
        const i = await Promise.all(impostorFiles.filter((f) => f.endsWith("-r0.wav")).map((f) => scoreOf(f, (a) => noisy(a, snr))));
        console.log(`RESULT noise ${String(snr).padStart(2)} dB SNR: owner accepted ${accepted(g)}/${g.length} (mean ${mean(g).toFixed(2)}) | other accepted ${accepted(i)}/${i.length} (mean ${mean(i).toFixed(2)})`);
        expect(accepted(g)).toBeGreaterThanOrEqual(3); // noise-augmented enrolment: the owner is still recognised in a noisy room
        expect(accepted(i)).toBe(0); // and noise never makes the other voice pass
      }
    } finally { rmSync(d, { recursive: true, force: true }); }
  }, 900_000);
});
