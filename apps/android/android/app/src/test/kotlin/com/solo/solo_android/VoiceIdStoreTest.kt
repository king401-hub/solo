package com.solo.solo_android

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files
import kotlin.math.sin
import kotlin.math.sqrt

// Mirrors apps/desktop/src/main/voice/voiceId.test.ts with a stand-in speaker model.
class VoiceIdStoreTest {
    private val dirs = mutableListOf<File>()
    @After fun cleanup() { dirs.forEach { it.deleteRecursively() } }
    private fun tmp(): File = Files.createTempDirectory("solo-vid").toFile().also { dirs += it }

    /** The first sample names the person (0.1 = Ann, 0.2 = Bob); a few more samples add small per-clip variation. */
    private val fake = object : Embedder {
        override fun embed(pcm: FloatArray): FloatArray? {
            if (pcm.size < 16000) return null
            val who = Math.round(pcm[0] * 10)
            val v = FloatArray(16) { 0.05f }
            v[who] = 1f
            for (i in 0 until 16) v[i] += pcm[1 + i] * 0.3f
            val n = sqrt(v.sumOf { it.toDouble() * it }).toFloat()
            return FloatArray(16) { v[it] / n }
        }
    }

    private fun audio(who: Int, seconds: Double = 4.0, seed: Int = 0, level: Double = 0.2): FloatArray {
        val a = FloatArray((seconds * 16000).toInt()) { (sin(it / 7.0 + seed) * level).toFloat() }
        a[0] = who / 10f
        for (i in 1..16) { val x = sin(seed * 12.9898 + i * 78.233) * 43758.5453; a[i] = ((x - Math.floor(x)) * 0.5).toFloat() }
        return a
    }

    private val xor = object : Crypt {
        override fun encrypt(plain: ByteArray) = ByteArray(plain.size) { (plain[it].toInt() xor 0x5a).toByte() }
        override fun decrypt(data: ByteArray) = ByteArray(data.size) { (data[it].toInt() xor 0x5a).toByte() }
    }

    private fun store(file: File, crypt: Crypt? = null, model: String = "m1") = VoiceIdStore(file, fake, model, crypt)

    private fun enrolled(file: File, crypt: Crypt? = null): VoiceIdStore {
        val v = store(file, crypt)
        for (i in 0 until 5) assertTrue(v.addClip(audio(1, 4.0, i)).ok)
        assertTrue(v.finishEnrollment().first)
        return v
    }

    @Test fun rejectsTooShortAndTooQuietRecordings() {
        val v = store(File(tmp(), "vp.bin"))
        assertTrue(v.addClip(audio(1, 1.0)).reason!!.contains("too short"))
        assertTrue(v.addClip(audio(1, 4.0, 0, 0.001)).reason!!.contains("too quiet"))
        assertEquals(0, v.status().pending)
    }

    @Test fun enrolsFromEnoughClipsThenRecognisesOwnerButNotSomeoneElse() {
        val v = store(File(tmp(), "vp.bin"))
        for (i in 0 until 3) v.addClip(audio(1, 4.0, i))
        assertFalse(v.finishEnrollment().first) // only 3
        v.addClip(audio(1, 4.0, 3)); v.addClip(audio(1, 4.0, 4))
        assertTrue(v.finishEnrollment().first)
        assertTrue(v.status().enrolled)
        assertTrue((v.verify(audio(1, 4.0, 77), 0.5) as Verify.Result).owner)
        assertFalse((v.verify(audio(2, 4.0, 78), 0.5) as Verify.Result).owner)
    }

    @Test fun refusesEnrolmentWhereAnotherPersonSpokeSomeRecordings() {
        val v = store(File(tmp(), "vp.bin"))
        listOf(1 to 0, 1 to 1, 2 to 2, 1 to 3, 2 to 4).forEach { (who, seed) -> v.addClip(audio(who, 4.0, seed)) }
        val (ok, q) = v.finishEnrollment()
        assertFalse(ok); assertTrue(q.reason!!.contains("alike")); assertFalse(v.status().enrolled)
    }

    @Test fun audioTooShortToJudgeIsReportedNeverGuessed() {
        val v = enrolled(File(tmp(), "vp.bin"))
        assertEquals(Verify.TooShort, v.verify(audio(1, 0.4), 0.5))
    }

    @Test fun withNoPrintVerificationSaysSo() {
        assertEquals(Verify.NotEnrolled, store(File(tmp(), "vp.bin")).verify(audio(1), 0.5))
    }

    @Test fun storedEncryptedAndSurvivesARestart() {
        val file = File(tmp(), "vp.bin")
        enrolled(file, xor)
        assertFalse(String(file.readBytes()).contains("centroid")) // no readable numbers on disk
        val again = store(file, xor)
        assertTrue(again.status().enrolled); assertTrue(again.status().encrypted)
        assertTrue((again.verify(audio(1, 4.0, 50), 0.5) as Verify.Result).owner)
    }

    @Test fun neverStoresAudioOnlyVectors() {
        val file = File(tmp(), "vp.bin")
        enrolled(file)
        val json = org.json.JSONObject(file.readText())
        assertEquals(setOf("v", "model", "createdAt", "centroid", "clips"), json.keys().asSequence().toSet())
        assertTrue(file.length() < 40_000) // numbers, not seconds of audio
    }

    @Test fun ignoresAPrintFromAnotherModelACorruptFileOrOneItCannotDecrypt() {
        val file = File(tmp(), "vp.bin"); enrolled(file)
        assertFalse(store(file, model = "other-model").status().enrolled)
        file.writeText("{ not json"); assertFalse(store(file).status().enrolled)
        val f2 = File(tmp(), "vp2.bin"); enrolled(f2, xor)
        val broken = object : Crypt { override fun encrypt(plain: ByteArray) = plain; override fun decrypt(data: ByteArray): ByteArray? = null }
        assertFalse(store(f2, broken).status().enrolled)
    }

    @Test fun resetDeletesTheVoicePrint() {
        val file = File(tmp(), "vp.bin"); val v = enrolled(file)
        assertTrue(file.exists()); v.reset()
        assertFalse(file.exists()); assertFalse(v.status().enrolled); assertEquals(Verify.NotEnrolled, v.verify(audio(1), 0.5))
    }

    @Test fun augmentationsKeepTheirLengthAndSpeedChangeScalesIt() {
        val a = audio(1, 4.0)
        assertEquals(a.size, Augment.noise(a, 10.0).size)
        assertEquals(a.size / 1.12, Augment.speed(a, 1.12).size.toDouble(), 1.0)
        assertEquals(4, Augment.variants(a).size)
        assertNotNull(Augment.variants(a).all { it.isNotEmpty() })
    }
}
