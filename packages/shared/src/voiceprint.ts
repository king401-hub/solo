/**
 * Voice print maths (pure; the embedding model itself runs in the desktop main process).
 *
 * A voice print is the average of several L2-normalised speaker embeddings taken while the owner reads a few sentences.
 * Recognising the owner later means: embed the new speech, take the cosine similarity with the print, compare with a
 * threshold. Only vectors are stored, never audio.
 *
 * What this is and is not: it is a convenience gate ("answer me, not the TV or a visitor"), not a security boundary like
 * a fingerprint. A recording or a synthetic copy of the owner's voice can pass it, and noise, illness or a different
 * microphone can make the owner fail. Do not use it alone to authorise consequential actions.
 */
export interface VoicePrint {
  v: 1;
  model: string;
  centroid: number[];
  clips: number[][];
  createdAt: number;
}

export const MIN_ENROLL_CLIPS = 4;

export function norm(v: ArrayLike<number>): number {
  let s = 0; for (let i = 0; i < v.length; i++) s += v[i]! * v[i]!;
  return Math.sqrt(s);
}

export function unit(v: ArrayLike<number>): number[] {
  const n = norm(v) || 1;
  return Array.from({ length: v.length }, (_, i) => v[i]! / n);
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) return -1;
  let s = 0; for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s / ((norm(a) * norm(b)) || 1);
}

export function centroid(vs: ArrayLike<number>[]): number[] {
  const out = new Array<number>(vs[0]!.length).fill(0);
  for (const v of vs) { const u = unit(v); for (let i = 0; i < out.length; i++) out[i]! += u[i]!; }
  return unit(out);
}

export interface EnrollQuality {
  ok: boolean;
  clips: number;
  /** lowest similarity of any clip to the average of the OTHER clips (1 = identical, lower = inconsistent) */
  minAgreement: number;
  meanAgreement: number;
  reason?: string;
}

/**
 * Builds a print from the owner's clips and checks they are consistent. Inconsistent clips (a second person talking,
 * heavy noise, a cut-off recording) would make a bad print, so enrolment is refused rather than silently accepted.
 */
export function buildPrint(clips: ArrayLike<number>[], model: string, opts: { minAgreement?: number; now?: number; /** embeddings of noisy / speed-varied copies of the same recordings */ augmented?: ArrayLike<number>[] } = {}): { print?: VoicePrint; quality: EnrollQuality } {
  const need = opts.minAgreement ?? 0.7;
  if (clips.length < MIN_ENROLL_CLIPS) return { quality: { ok: false, clips: clips.length, minAgreement: 0, meanAgreement: 0, reason: `Need at least ${MIN_ENROLL_CLIPS} recordings` } };
  const agreements = clips.map((c, i) => cosine(c, centroid(clips.filter((_, j) => j !== i))));
  const min = Math.min(...agreements), mean = agreements.reduce((a, b) => a + b, 0) / agreements.length;
  if (min < need) {
    return { quality: { ok: false, clips: clips.length, minAgreement: min, meanAgreement: mean, reason: "The recordings did not sound alike enough. Record again in a quiet place, only you speaking, at your normal volume." } };
  }
  // The consistency check above uses only the real recordings; the augmented copies just make the print tolerant of noise
  // and of speaking faster or slower than during enrolment.
  const all = [...clips, ...(opts.augmented ?? [])];
  const print: VoicePrint = { v: 1, model, centroid: centroid(all), clips: all.map((c) => unit(c)), createdAt: opts.now ?? Date.now() };
  return { print, quality: { ok: true, clips: clips.length, minAgreement: min, meanAgreement: mean } };
}

export function score(print: VoicePrint, embedding: ArrayLike<number>): number {
  return cosine(print.centroid, embedding);
}

/**
 * Strictness 0..1 -> cosine threshold. Low = lenient (fewer misses, more strangers accepted), high = strict.
 * The range is calibrated from measurements (see docs/VOICE.md); change both together.
 */
export const THRESHOLD_LENIENT = 0.74;
export const THRESHOLD_STRICT = 0.92;
export function thresholdFor(strictness: number): number {
  const s = Math.min(1, Math.max(0, strictness));
  return THRESHOLD_LENIENT + (THRESHOLD_STRICT - THRESHOLD_LENIENT) * s;
}

export function isOwner(print: VoicePrint, embedding: ArrayLike<number>, strictness: number): { score: number; owner: boolean } {
  const s = score(print, embedding);
  return { score: s, owner: s >= thresholdFor(strictness) };
}
