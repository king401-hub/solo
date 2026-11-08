/** Local speech-to-text (Whisper via transformers.js / ONNX). No network except the one-time model download. */
export interface Stt {
  /** Resolves when the model is loaded (downloads on first use). */
  warmup(onProgress?: (pct: number) => void): Promise<void>;
  /** 16 kHz mono float PCM in [-1, 1] -> text ("" if nothing intelligible). */
  transcribe(pcm16k: Float32Array): Promise<string>;
}

// Whisper tends to hallucinate these on near-silence/noise. Drop them when they are the whole transcript.
const HALLUCINATIONS = new Set([
  "", "you", "thank you", "thanks for watching", "thank you for watching", "bye", "blank audio", "silence", "music",
]);

export function cleanTranscript(raw: string): string {
  const t = raw.replace(/\[[^\]]*\]|\([^)]*\)/g, " ").replace(/\s+/g, " ").trim(); // [BLANK_AUDIO], (music) ...
  const key = t.toLowerCase().replace(/[^a-z\s]/g, "").trim();
  return HALLUCINATIONS.has(key) ? "" : t;
}

/** Speech-recognition model sizes: bigger is more accurate (especially on accents) but slower. All are English-only models. */
export const ASR_MODELS = { fast: "Xenova/whisper-tiny.en", better: "Xenova/whisper-base.en", best: "Xenova/whisper-small.en" } as const;
export type AsrPreset = keyof typeof ASR_MODELS;

export function createStt(opts: { cacheDir: string; model?: string }): Stt {
  const model = opts.model ?? ASR_MODELS.fast;
  let loading: Promise<(audio: Float32Array, o?: object) => Promise<{ text: string }>> | undefined;
  const load = (onProgress?: (pct: number) => void) =>
    (loading ??= (async () => {
      const { pipeline, env } = await import("@huggingface/transformers");
      env.cacheDir = opts.cacheDir;
      const p = await pipeline("automatic-speech-recognition", model, {
        dtype: "q8",
        progress_callback: (e: { status?: string; progress?: number }) => {
          if (e.status === "progress" && typeof e.progress === "number") onProgress?.(Math.round(e.progress));
        },
      } as never);
      return p as never;
    })().catch((err) => { loading = undefined; throw err; }));
  // serialize: one inference at a time
  let chain: Promise<unknown> = Promise.resolve();
  return {
    async warmup(onProgress) { await load(onProgress); },
    transcribe(pcm) {
      const run = chain.then(async () => cleanTranscript((await (await load())(pcm, { chunk_length_s: 30 })).text));
      chain = run.catch(() => undefined);
      return run;
    },
  };
}
