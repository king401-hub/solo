package com.solo.solo_android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// Same cases as packages/shared/src/voiceprint.test.ts (same pseudo-random generator, so the data is identical).
class VoicePrintMathTest {
    private fun rng(seed: Long): () -> Double { var s = seed; return { s = (s * 1664525L + 1013904223L) % 4294967296L; s / 4294967296.0 - 0.5 } }
    private fun person(seed: Long, dim: Int = 64): FloatArray { val r = rng(seed); return FloatArray(dim) { (r() * 2).toFloat() } }
    private fun clipOf(p: FloatArray, noise: Double, seed: Long): FloatArray { val r = rng(seed); return VoicePrintMath.unit(FloatArray(p.size) { (p[it] + r() * noise).toFloat() }) }

    private val me = person(1)
    private val other = person(2)

    @Test fun cosineBasics() {
        assertEquals(1.0, VoicePrintMath.cosine(floatArrayOf(1f, 0f), floatArrayOf(1f, 0f)), 1e-9)
        assertEquals(0.0, VoicePrintMath.cosine(floatArrayOf(1f, 0f), floatArrayOf(0f, 1f)), 1e-9)
        assertEquals(-1.0, VoicePrintMath.cosine(floatArrayOf(1f, 0f), floatArrayOf(-1f, 0f)), 1e-9)
        assertEquals(-1.0, VoicePrintMath.cosine(floatArrayOf(1f, 0f), floatArrayOf(1f, 0f, 0f)), 0.0) // different models never match
        assertEquals(0.0, VoicePrintMath.cosine(floatArrayOf(0f, 0f), floatArrayOf(1f, 0f)), 0.0)
    }

    @Test fun buildsFromConsistentClipsAndRejectsTooFew() {
        val clips = (0 until VoicePrintMath.MIN_ENROLL_CLIPS).map { clipOf(me, 0.3, 10L + it) }
        val (p, q) = VoicePrintMath.buildPrint(clips, "m", now = 5)
        assertTrue(q.ok); assertNotNull(p); assertEquals(5L, p!!.createdAt); assertEquals(VoicePrintMath.MIN_ENROLL_CLIPS, p.clips.size)
        val (few, qf) = VoicePrintMath.buildPrint(clips.take(2), "m")
        assertFalse(qf.ok); assertNull(few)
    }

    @Test fun refusesInconsistentEnrolment() {
        val clips = listOf(clipOf(me, 0.3, 1), clipOf(me, 0.3, 2), clipOf(me, 0.3, 3), clipOf(other, 0.3, 4))
        val (p, q) = VoicePrintMath.buildPrint(clips, "m")
        assertFalse(q.ok); assertTrue(q.reason!!.contains("alike")); assertNull(p)
    }

    @Test fun augmentedCopiesWidenThePrintButDoNotAffectTheConsistencyCheck() {
        val clips = (0 until 5).map { clipOf(me, 0.3, 20L + it) }
        val (p, q) = VoicePrintMath.buildPrint(clips, "m", augmented = listOf(clipOf(me, 0.9, 50), clipOf(me, 0.9, 51)))
        assertTrue(q.ok); assertEquals(7, p!!.clips.size)
        // garbage "augmented" vectors cannot rescue (or break) the consistency verdict
        val mixed = listOf(clipOf(me, 0.3, 1), clipOf(me, 0.3, 2), clipOf(me, 0.3, 3), clipOf(other, 0.3, 4))
        assertFalse(VoicePrintMath.buildPrint(mixed, "m", augmented = listOf(clipOf(me, 0.3, 9))).second.ok)
    }

    @Test fun acceptsOwnerRejectsOtherAtNormalStrictness() {
        val (p) = VoicePrintMath.buildPrint((0 until 5).map { clipOf(me, 0.3, 20L + it) }, "m")
        val mine = VoicePrintMath.isOwner(p!!, clipOf(me, 0.3, 99), 0.5)
        val theirs = VoicePrintMath.isOwner(p, clipOf(other, 0.3, 98), 0.5)
        assertTrue(mine.second); assertFalse(theirs.second); assertTrue(mine.first > theirs.first)
        assertTrue(VoicePrintMath.score(p, VoicePrintMath.centroid(p.clips)) > 0.95)
    }

    @Test fun strictnessIsMonotonicAndClamped() {
        assertTrue(VoicePrintMath.thresholdFor(0.0) < VoicePrintMath.thresholdFor(0.5))
        assertTrue(VoicePrintMath.thresholdFor(0.5) < VoicePrintMath.thresholdFor(1.0))
        assertEquals(VoicePrintMath.thresholdFor(0.0), VoicePrintMath.thresholdFor(-3.0), 0.0)
        assertEquals(VoicePrintMath.thresholdFor(1.0), VoicePrintMath.thresholdFor(9.0), 0.0)
        // the default strictness gives the threshold the desktop measured with (about 0.785)
        assertEquals(0.785, VoicePrintMath.thresholdFor(VoicePrintMath.DEFAULT_STRICTNESS), 1e-6)
    }

    @Test fun printSurvivesJsonRoundTripAndGarbageIsRejected() {
        val (p) = VoicePrintMath.buildPrint((0 until 5).map { clipOf(me, 0.3, 30L + it) }, "m1", now = 7)
        val back = VoicePrintMath.fromJson(VoicePrintMath.toJson(p!!))!!
        assertEquals("m1", back.model); assertEquals(7L, back.createdAt); assertEquals(p.clips.size, back.clips.size)
        assertEquals(1.0, VoicePrintMath.cosine(p.centroid, back.centroid), 1e-6)
        assertNull(VoicePrintMath.fromJson("{ not json")); assertNull(VoicePrintMath.fromJson("{\"v\":2}"))
    }
}
