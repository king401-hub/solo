import { describe, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ASR_MODELS, createStt, type AsrPreset } from "./stt";

/**
 * Exploratory benchmark (opt-in): speed and word-error rate of the speech-recognition presets on clean synthetic speech.
 * It says nothing about accents: there is no Nigerian-accented audio on this machine to measure with.
 *   SOLO_VOICES_DIR=<dir> SOLO_ASR_PRESETS=fast,better npx vitest run asr.bench
 */
const dir = process.env["SOLO_VOICES_DIR"];
const presets = (process.env["SOLO_ASR_PRESETS"] ?? "fast,better").split(",") as AsrPreset[];
const wav = (f: string) => { const b = readFileSync(join(dir!, f)); const i = b.indexOf("data"); const pcm = new Int16Array(b.buffer.slice(b.byteOffset + i + 8, b.byteOffset + b.length - ((b.length - i - 8) % 2))); return Float32Array.from(pcm, (v) => v / 32768); };
const REF: Record<string, string> = {
  "david-n0-r0.wav": "Tomorrow morning I need to finish the report and send it before noon.",
  "david-n1-r0.wav": "Could you please read my unread messages and tell me which ones are urgent?",
  "david-n2-r0.wav": "My favourite part of the day is the early morning when everything is quiet.",
  "david-n3-r0.wav": "Turn the volume down a little and play something relaxing while I work.",
  "david-1-r0.wav": "Please open the project folder and show me the latest changes from yesterday.",
  "david-4-r0.wav": "Remind me to call the bank before four o'clock and to buy some groceries.",
};
const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s']/g, " ").split(/\s+/).filter(Boolean);
function wer(ref: string, hyp: string) {
  const r = words(ref), h = words(hyp);
  const d = Array.from({ length: r.length + 1 }, (_, i) => Array.from({ length: h.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= r.length; i++) for (let j = 1; j <= h.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (r[i - 1] === h[j - 1] ? 0 : 1));
  return d[r.length]![h.length]! / r.length;
}

describe.skipIf(!dir || !existsSync(join(dir ?? "", "david-n0-r0.wav")))("ASR presets", () => {
  for (const preset of presets) {
    it(`measures ${preset}`, async () => {
      const stt = createStt({ cacheDir: join(homedir(), ".solo-test-models"), model: ASR_MODELS[preset] });
      const t0 = Date.now(); await stt.warmup(); const load = Date.now() - t0;
      let secs = 0, ms = 0, errs = 0, n = 0;
      await stt.transcribe(wav("david-n0-r0.wav")); // warm-up run (first inference is slower)
      for (const [f, ref] of Object.entries(REF)) {
        const a = wav(f); const t = Date.now(); const hyp = await stt.transcribe(a); const dt = Date.now() - t;
        secs += a.length / 16000; ms += dt; errs += wer(ref, hyp); n++;
        console.log(`ASR ${preset} ${f} ${(dt / 1000).toFixed(1)}s for ${(a.length / 16000).toFixed(1)}s audio | WER ${(wer(ref, hyp) * 100).toFixed(0)}% | "${hyp.trim()}"`);
      }
      console.log(`ASR SUMMARY ${preset} (${ASR_MODELS[preset]}): load ${(load / 1000).toFixed(1)}s, ${(ms / n / 1000).toFixed(1)}s per utterance (${(ms / 1000 / secs).toFixed(2)}x real time), mean WER ${((errs / n) * 100).toFixed(1)}%`);
    }, 1_800_000);
  }
});
