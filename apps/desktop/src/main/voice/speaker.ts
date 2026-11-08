/**
 * Local speaker embedding ("voice print"): turns speech into a 512-number vector that is close for the same person and
 * far for different people. Runs fully offline (WavLM-base-plus speaker-verification model via transformers.js / ONNX);
 * audio is never sent anywhere and only the vector is kept.
 */
export interface Speaker {
  warmup(onProgress?: (pct: number) => void): Promise<void>;
  /** 16 kHz mono float PCM -> L2-normalised embedding, or undefined if the audio is too short to judge. */
  embed(pcm16k: Float32Array): Promise<Float32Array | undefined>;
}

export const MIN_SPEAKER_SECONDS = 1.0;
export const MAX_SPEAKER_SECONDS = 12;

export function createSpeaker(opts: { cacheDir: string; model?: string }): Speaker {
  const model = opts.model ?? "Xenova/wavlm-base-plus-sv";
  type Tensor = { data: Float32Array };
  let loading: Promise<{ processor: (a: Float32Array) => Promise<unknown>; model: (i: unknown) => Promise<{ embeddings: Tensor }> }> | undefined;
  const load = (onProgress?: (pct: number) => void) =>
    (loading ??= (async () => {
      const t = await import("@huggingface/transformers");
      t.env.cacheDir = opts.cacheDir;
      const progress_callback = (e: { status?: string; progress?: number }) => {
        if (e.status === "progress" && typeof e.progress === "number") onProgress?.(Math.round(e.progress));
      };
      const processor = await t.AutoProcessor.from_pretrained(model, { progress_callback } as never);
      const m = await t.AutoModel.from_pretrained(model, { dtype: "q8", progress_callback } as never);
      return { processor: processor as never, model: m as never };
    })().catch((e) => { loading = undefined; throw e; }));

  let chain: Promise<unknown> = Promise.resolve();
  return {
    async warmup(onProgress) { await load(onProgress); },
    embed(pcm) {
      if (pcm.length < MIN_SPEAKER_SECONDS * 16000) return Promise.resolve(undefined);
      const clip = pcm.length > MAX_SPEAKER_SECONDS * 16000 ? pcm.subarray(0, MAX_SPEAKER_SECONDS * 16000) : pcm;
      const run = chain.then(async () => {
        const m = await load();
        const inputs = await m.processor(clip);
        const { embeddings } = await m.model(inputs);
        const v = Float32Array.from(embeddings.data);
        let n = 0; for (const x of v) n += x * x;
        n = Math.sqrt(n) || 1;
        return v.map((x) => x / n);
      });
      chain = run.catch(() => undefined);
      return run;
    },
  };
}
