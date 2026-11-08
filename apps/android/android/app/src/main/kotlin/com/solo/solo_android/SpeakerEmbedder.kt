package com.solo.solo_android

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import java.io.File
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.ln
import kotlin.math.sqrt

/** Anything that can turn 16 kHz mono speech into a speaker embedding (a real model, or a stand-in in tests). */
interface Embedder { fun embed(pcm: FloatArray): FloatArray? }

/**
 * Speaker embedding with the WavLM-base-plus speaker-verification model (ONNX), the same model the desktop uses, so the
 * accuracy measured there (docs/VOICE.md) applies here. Runs fully on the phone; audio never leaves it.
 * Preprocessing is the model's own feature extractor: for this model that is the raw 16 kHz waveform, no normalisation.
 */
class SpeakerEmbedder(private val modelFile: () -> File, private val threads: Int = 4) : Embedder {
    companion object {
        const val MIN_SECONDS = 1.0
        const val MAX_SECONDS = 12.0
        const val RATE = 16000
    }

    private var env: OrtEnvironment? = null
    private var session: OrtSession? = null

    @Synchronized private fun load(): OrtSession {
        session?.let { return it }
        val e = OrtEnvironment.getEnvironment()
        val opts = OrtSession.SessionOptions().apply { setIntraOpNumThreads(threads) }
        env = e
        return e.createSession(modelFile().absolutePath, opts).also { session = it }
    }

    @Synchronized fun close() { session?.close(); session = null }

    /** Names of the model's inputs and outputs (diagnostics and tests). */
    fun ioNames(): Pair<Set<String>, Set<String>> = load().let { it.inputNames to it.outputNames }

    /** Null if the audio is too short to judge. The result is L2-normalised. */
    @Synchronized override fun embed(pcm: FloatArray): FloatArray? {
        if (pcm.size < MIN_SECONDS * RATE) return null
        val clip = if (pcm.size > MAX_SECONDS * RATE) pcm.copyOf((MAX_SECONDS * RATE).toInt()) else pcm
        val s = load()
        // This model's own feature extractor has do_normalize = false (preprocessor_config.json), so it takes the raw waveform.
        val norm = clip
        OnnxTensor.createTensor(env, arrayOf(norm)).use { t ->
            s.run(mapOf(s.inputNames.first() to t)).use { res ->
                var emb: FloatArray? = null
                for (entry in res) {
                    val value = entry.value.value
                    @Suppress("UNCHECKED_CAST")
                    if (value is Array<*> && value.size == 1 && value[0] is FloatArray && (entry.key == "embeddings" || emb == null && (value[0] as FloatArray).size == 512)) emb = (value[0] as FloatArray)
                }
                return emb?.let { VoicePrintMath.unit(it) }
            }
        }
    }
}

/** Copies of an enrolment recording under real-life conditions: noise, and speaking faster or slower. */
object Augment {
    /** Deterministic Gaussian noise at a signal-to-noise ratio in dB (same generator as the desktop). */
    fun noise(a: FloatArray, snrDb: Double, seed: Long = 1): FloatArray {
        var p = 0.0; for (x in a) p += x.toDouble() * x
        p /= maxOf(1, a.size)
        val sigma = sqrt(p / Math.pow(10.0, snrDb / 10))
        var st = seed
        fun rnd(): Double { st = (st * 1664525L + 1013904223L) % 4294967296L; return st / 4294967296.0 }
        return FloatArray(a.size) { i ->
            val r1 = rnd().let { if (it == 0.0) 1e-9 else it }; val r2 = rnd()
            (a[i] + sigma * sqrt(-2 * ln(r1)) * cos(2 * PI * r2)).toFloat()
        }
    }

    /** Linear-interpolation speed change (factor 1.12 = 12% faster). */
    fun speed(a: FloatArray, factor: Double): FloatArray {
        val n = (a.size / factor).toInt()
        return FloatArray(n) { i ->
            val pos = i * factor; val i0 = pos.toInt(); val i1 = minOf(i0 + 1, a.size - 1); val f = (pos - i0).toFloat()
            a[i0] * (1 - f) + a[i1] * f
        }
    }

    fun variants(pcm: FloatArray): List<FloatArray> = listOf(noise(pcm, 20.0, 7), noise(pcm, 10.0, 11), speed(pcm, 1.12), speed(pcm, 0.9))
}
