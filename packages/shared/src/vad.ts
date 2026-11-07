/** Linear-interpolation resampler (mic rate -> 16 kHz for speech recognition). */
export function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const f = pos - i0;
    out[i] = input[i0]! * (1 - f) + input[i1]! * f;
  }
  return out;
}

export function rms(frame: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i]! * frame[i]!;
  return Math.sqrt(sum / Math.max(1, frame.length));
}

export interface SegmenterOptions {
  sampleRate: number; // of the frames pushed in
  /** speech if rms > max(minRms, noiseFloor * factor) */
  minRms: number;
  factor: number;
  minSpeechMs: number;
  endSilenceMs: number;
  maxUtteranceMs: number;
  prerollMs: number;
}

export const defaultSegmenter: SegmenterOptions = {
  sampleRate: 16000, minRms: 0.015, factor: 3, minSpeechMs: 250, endSilenceMs: 700, maxUtteranceMs: 15000, prerollMs: 300,
};

/**
 * Energy-based utterance segmenter. Feed it consecutive frames; it returns the audio of a finished utterance
 * (with a little pre-roll so the first syllable is not clipped) or null. Nothing leaves this object until speech has
 * ended, and silence/noise is never emitted, so idle microphones produce no audio data at all.
 */
export class Segmenter {
  private o: SegmenterOptions;
  private noise = 0.005;
  private preroll: Float32Array[] = [];
  private prerollSamples = 0;
  private cur: Float32Array[] = [];
  private curSamples = 0;
  private speechSamples = 0;
  private silenceSamples = 0;
  private inSpeech = false;
  /** Set true while speech is in progress (for UI / barge-in). */
  get speaking() { return this.inSpeech; }

  constructor(opts: Partial<SegmenterOptions> = {}) { this.o = { ...defaultSegmenter, ...opts }; }

  private ms(samples: number) { return (samples / this.o.sampleRate) * 1000; }

  reset() {
    this.preroll = []; this.prerollSamples = 0; this.cur = []; this.curSamples = 0;
    this.speechSamples = 0; this.silenceSamples = 0; this.inSpeech = false;
  }

  push(frame: Float32Array): Float32Array | null {
    const level = rms(frame);
    const isSpeech = level > Math.max(this.o.minRms, this.noise * this.o.factor);
    if (!isSpeech && !this.inSpeech) this.noise = this.noise * 0.95 + level * 0.05; // track ambient noise only when quiet

    if (!this.inSpeech) {
      this.preroll.push(frame); this.prerollSamples += frame.length;
      while (this.ms(this.prerollSamples) > this.o.prerollMs && this.preroll.length > 1) this.prerollSamples -= this.preroll.shift()!.length;
      if (isSpeech) {
        this.inSpeech = true;
        this.cur = [...this.preroll]; this.curSamples = this.prerollSamples;
        this.speechSamples = frame.length; this.silenceSamples = 0;
        this.preroll = []; this.prerollSamples = 0;
      }
      return null;
    }

    this.cur.push(frame); this.curSamples += frame.length;
    if (isSpeech) { this.speechSamples += frame.length; this.silenceSamples = 0; } else this.silenceSamples += frame.length;

    const tooLong = this.ms(this.curSamples) >= this.o.maxUtteranceMs;
    if (this.ms(this.silenceSamples) >= this.o.endSilenceMs || tooLong) {
      const enough = this.ms(this.speechSamples) >= this.o.minSpeechMs;
      const out = enough ? concat(this.cur, this.curSamples) : null; // blips (clicks, coughs) are dropped
      this.reset();
      return out;
    }
    return null;
  }
}

function concat(parts: Float32Array[], total: number): Float32Array {
  const out = new Float32Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
