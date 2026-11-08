import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { MIN_ENROLL_CLIPS, buildPrint, isOwner, resample, rms, type EnrollQuality, type VoicePrint } from "@solo/shared";
import type { Speaker } from "./speaker";

export interface VoiceIdStatus {
  enrolled: boolean;
  createdAt?: number;
  /** recordings collected so far in an enrolment in progress */
  pending: number;
  needed: number;
  /** false if the OS could not encrypt the stored print (it is then protected by file permissions only) */
  encrypted: boolean;
}

export interface ClipResult { ok: boolean; count: number; reason?: string }
export type Verify =
  | { enrolled: false }
  | { enrolled: true; tooShort: true }
  | { enrolled: true; tooShort?: false; score: number; owner: boolean };

const MIN_CLIP_SECONDS = 3;
const MIN_CLIP_LEVEL = 0.008; // average level; quieter than this is almost certainly a muted/far microphone

/** Deterministic Gaussian noise at a given signal-to-noise ratio (dB). */
export function addNoise(a: Float32Array, snrDb: number, seed = 1): Float32Array {
  const p = a.reduce((s, x) => s + x * x, 0) / Math.max(1, a.length);
  const sigma = Math.sqrt(p / 10 ** (snrDb / 10));
  let st = seed; const rnd = () => { st = (st * 1664525 + 1013904223) % 4294967296; return st / 4294967296; };
  return a.map((x) => x + sigma * Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd()));
}

/**
 * Copies of an enrolment recording under the conditions real life brings: some background noise, and speaking a little
 * faster or slower. Their embeddings widen the voice print so the owner is still recognised in those conditions.
 */
export function augmentations(pcm: Float32Array): Float32Array[] {
  return [addNoise(pcm, 20, 7), addNoise(pcm, 10, 11), resample(pcm, 16000 * 1.12, 16000), resample(pcm, 16000 * 0.9, 16000)];
}

/**
 * The owner's voice print: enrolment from several recordings, storage (encrypted with the OS keystore where available),
 * and verification of new speech. Only embeddings are kept, never audio. Not synced to any other device.
 */
export class VoiceId {
  private print?: VoicePrint;
  private pending: number[][] = [];
  private pendingAug: number[][] = [];
  private encrypted = false;

  constructor(private o: {
    file: string;
    speaker: Speaker;
    model: string;
    /** OS-keystore encryption (Electron safeStorage). Tests pass identity functions. */
    encrypt?: (plain: string) => Buffer | null;
    decrypt?: (data: Buffer) => string | null;
  }) { this.load(); }

  private load() {
    if (!existsSync(this.o.file)) return;
    try {
      const raw = readFileSync(this.o.file);
      const text = this.o.decrypt ? this.o.decrypt(raw) : raw.toString("utf8");
      const p = JSON.parse(text ?? "") as VoicePrint;
      if (p?.v === 1 && Array.isArray(p.centroid) && p.model === this.o.model) { this.print = p; this.encrypted = !!this.o.decrypt; }
    } catch { /* unreadable or from another model/machine: treated as not enrolled; the user re-records */ }
  }

  private save(p: VoicePrint) {
    mkdirSync(dirname(this.o.file), { recursive: true });
    const text = JSON.stringify(p);
    const enc = this.o.encrypt?.(text) ?? null;
    this.encrypted = !!enc;
    const tmp = this.o.file + ".tmp";
    writeFileSync(tmp, enc ?? text, { mode: 0o600 });
    renameSync(tmp, this.o.file);
  }

  status(): VoiceIdStatus {
    return { enrolled: !!this.print, createdAt: this.print?.createdAt, pending: this.pending.length, needed: MIN_ENROLL_CLIPS, encrypted: this.encrypted };
  }

  startEnrollment() { this.pending = []; this.pendingAug = []; }
  cancelEnrollment() { this.pending = []; this.pendingAug = []; }

  /** Add one recording (16 kHz mono) to the enrolment in progress. */
  async addClip(pcm: Float32Array): Promise<ClipResult> {
    if (pcm.length < MIN_CLIP_SECONDS * 16000) return { ok: false, count: this.pending.length, reason: `That was too short. Read the whole sentence (at least ${MIN_CLIP_SECONDS} seconds).` };
    if (rms(pcm) < MIN_CLIP_LEVEL) return { ok: false, count: this.pending.length, reason: "That was too quiet. Speak at your normal volume, close to the microphone." };
    const e = await this.o.speaker.embed(pcm);
    if (!e) return { ok: false, count: this.pending.length, reason: "Could not analyse that recording. Try again." };
    this.pending.push(Array.from(e));
    for (const variant of augmentations(pcm)) { const v = await this.o.speaker.embed(variant); if (v) this.pendingAug.push(Array.from(v)); }
    return { ok: true, count: this.pending.length };
  }

  /** Turn the collected recordings into the voice print (refused if they are inconsistent). */
  finishEnrollment(): { ok: boolean; quality: EnrollQuality } {
    const r = buildPrint(this.pending, this.o.model, { augmented: this.pendingAug });
    if (r.print) { this.print = r.print; this.save(r.print); this.pending = []; this.pendingAug = []; }
    return { ok: !!r.print, quality: r.quality };
  }

  async verify(pcm: Float32Array, strictness: number): Promise<Verify> {
    if (!this.print) return { enrolled: false };
    const e = await this.o.speaker.embed(pcm);
    if (!e) return { enrolled: true, tooShort: true };
    return { enrolled: true, ...isOwner(this.print, e, strictness) };
  }

  /** Delete the voice print. */
  reset() {
    this.print = undefined; this.pending = []; this.pendingAug = [];
    try { rmSync(this.o.file, { force: true }); } catch { /* already gone */ }
  }
}
