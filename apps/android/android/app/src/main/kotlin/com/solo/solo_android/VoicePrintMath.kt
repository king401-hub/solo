package com.solo.solo_android

import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.sqrt

/**
 * Voice print maths. Mirrors packages/shared/src/voiceprint.ts (keep the cases in VoicePrintMathTest identical to
 * voiceprint.test.ts and the constants identical).
 *
 * A voice print is the average of several L2-normalised speaker embeddings from the owner reading sentences. Only vectors
 * are stored, never audio. This is a convenience gate, not a security boundary: a recording or a synthetic copy of the
 * owner's voice can pass it, and noise or illness can make the owner fail.
 */
object VoicePrintMath {
    const val MIN_ENROLL_CLIPS = 4
    const val THRESHOLD_LENIENT = 0.74
    const val THRESHOLD_STRICT = 0.92
    /** Default strictness; chosen from measurements (see docs/VOICE.md). */
    const val DEFAULT_STRICTNESS = 0.25

    class Print(val model: String, val centroid: FloatArray, val clips: List<FloatArray>, val createdAt: Long)
    data class Quality(val ok: Boolean, val clips: Int, val minAgreement: Double, val meanAgreement: Double, val reason: String? = null)

    fun norm(v: FloatArray): Double { var s = 0.0; for (x in v) s += x.toDouble() * x; return sqrt(s) }

    fun unit(v: FloatArray): FloatArray { val n = norm(v).let { if (it == 0.0) 1.0 else it }; return FloatArray(v.size) { (v[it] / n).toFloat() } }

    fun cosine(a: FloatArray, b: FloatArray): Double {
        if (a.size != b.size) return -1.0 // vectors from different models never match
        var s = 0.0; for (i in a.indices) s += a[i].toDouble() * b[i]
        val d = norm(a) * norm(b)
        return if (d == 0.0) 0.0 else s / d
    }

    fun centroid(vs: List<FloatArray>): FloatArray {
        val out = FloatArray(vs[0].size)
        for (v in vs) { val u = unit(v); for (i in out.indices) out[i] += u[i] }
        return unit(out)
    }

    /**
     * Builds a print and checks the recordings are consistent (a second speaker, noise or a cut-off recording would make a
     * bad print, so enrolment is refused). [augmented] are embeddings of noisy / speed-varied copies of the same recordings;
     * they widen the print but are not part of the consistency check.
     */
    fun buildPrint(clips: List<FloatArray>, model: String, augmented: List<FloatArray> = emptyList(), minAgreement: Double = 0.7, now: Long = System.currentTimeMillis()): Pair<Print?, Quality> {
        if (clips.size < MIN_ENROLL_CLIPS) return null to Quality(false, clips.size, 0.0, 0.0, "Need at least $MIN_ENROLL_CLIPS recordings")
        val agreements = clips.indices.map { i -> cosine(clips[i], centroid(clips.filterIndexed { j, _ -> j != i })) }
        val min = agreements.min(); val mean = agreements.average()
        if (min < minAgreement) return null to Quality(false, clips.size, min, mean, "The recordings did not sound alike enough. Record again in a quiet place, only you speaking, at your normal volume.")
        val all = clips + augmented
        return Print(model, centroid(all), all.map { unit(it) }, now) to Quality(true, clips.size, min, mean)
    }

    fun score(p: Print, e: FloatArray): Double = cosine(p.centroid, e)

    /** Strictness 0..1 to cosine threshold (0 = lenient, 1 = strict). */
    fun thresholdFor(strictness: Double): Double {
        val s = strictness.coerceIn(0.0, 1.0)
        return THRESHOLD_LENIENT + (THRESHOLD_STRICT - THRESHOLD_LENIENT) * s
    }

    fun isOwner(p: Print, e: FloatArray, strictness: Double): Pair<Double, Boolean> {
        val s = score(p, e)
        return s to (s >= thresholdFor(strictness))
    }

    fun toJson(p: Print): String = JSONObject()
        .put("v", 1).put("model", p.model).put("createdAt", p.createdAt)
        .put("centroid", vec(p.centroid)).put("clips", JSONArray().also { a -> p.clips.forEach { a.put(vec(it)) } })
        .toString()

    fun fromJson(s: String): Print? = try {
        val j = JSONObject(s)
        if (j.optInt("v") != 1) null else Print(
            j.getString("model"), floats(j.getJSONArray("centroid")),
            (0 until j.getJSONArray("clips").length()).map { floats(j.getJSONArray("clips").getJSONArray(it)) }, j.getLong("createdAt"),
        )
    } catch (_: Exception) { null }

    private fun vec(f: FloatArray) = JSONArray().also { a -> f.forEach { a.put(it.toDouble()) } }
    private fun floats(a: JSONArray) = FloatArray(a.length()) { a.getDouble(it).toFloat() }
}
