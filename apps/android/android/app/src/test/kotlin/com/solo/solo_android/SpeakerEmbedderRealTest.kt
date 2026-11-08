package com.solo.solo_android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.file.Files

/**
 * Opt-in: runs the REAL speaker model through the Kotlin code on the PC and checks it reproduces the scores the desktop
 * measured (docs/VOICE.md), so the phone and desktop share the same accuracy. Needs:
 *   SOLO_VOICES_DIR   folder with david-N-rR.wav / zira-N-rR.wav / david-nN-rR.wav (16 kHz mono 16-bit)
 *   SOLO_WAVLM_MODEL  path to model_quantized.onnx
 * As on the desktop, the two "people" are the Windows text-to-speech voices David and Zira; real-voice accuracy is unmeasured.
 */
class SpeakerEmbedderRealTest {
    private val dir = System.getenv("SOLO_VOICES_DIR")
    private val model = System.getenv("SOLO_WAVLM_MODEL")

    private fun wav(name: String): FloatArray {
        val b = File(dir, name).readBytes()
        var i = 0
        while (i < b.size - 4 && String(b, i, 4) != "data") i++
        val bb = ByteBuffer.wrap(b, i + 8, b.size - i - 8).order(ByteOrder.LITTLE_ENDIAN)
        val n = (b.size - i - 8) / 2
        return FloatArray(n) { bb.short / 32768f }
    }

    @Test fun realModelReproducesTheDesktopResults() {
        assumeTrue("set SOLO_VOICES_DIR and SOLO_WAVLM_MODEL to run", !dir.isNullOrEmpty() && !model.isNullOrEmpty() && File(dir, "david-0-r0.wav").exists())
        val embedder = SpeakerEmbedder({ File(model!!) })
        val (inputs, outputs) = embedder.ioNames()
        println("MODEL io: inputs=$inputs outputs=$outputs")

        val tmp = Files.createTempDirectory("solo-vid-real").toFile()
        try {
            val store = VoiceIdStore(File(tmp, "vp.bin"), embedder, "Xenova/wavlm-base-plus-sv")
            val t0 = System.currentTimeMillis()
            for (n in 0..4) assertTrue(store.addClip(wav("david-$n-r0.wav")).ok)
            println("ENROL ms for 5 clips (each with 4 augmented copies): ${System.currentTimeMillis() - t0}")
            val (ok, q) = store.finishEnrollment()
            println("ENROL agreement min/mean ${"%.3f".format(q.minAgreement)} ${"%.3f".format(q.meanAgreement)} (desktop: 0.790 0.880) ok=$ok ${q.reason ?: ""}")
            assertTrue(q.reason ?: "enrolment refused", ok)

            val strictness = VoicePrintMath.DEFAULT_STRICTNESS
            val threshold = VoicePrintMath.thresholdFor(strictness)
            val rates = listOf("r0", "r1", "r-1")
            fun scores(prefix: String) = (0..3).flatMap { n -> rates.map { r -> (store.verify(wav("$prefix-n$n-$r.wav"), strictness) as Verify.Result).score } }
            val t1 = System.currentTimeMillis()
            val genuine = scores("david"); val impostor = scores("zira")
            println("VERIFY ms per clip: ${(System.currentTimeMillis() - t1) / (genuine.size + impostor.size)}")
            println("RESULT threshold ${"%.3f".format(threshold)}")
            println("RESULT genuine  accepted ${genuine.count { it >= threshold }}/${genuine.size} mean ${"%.3f".format(genuine.average())} ${genuine.joinToString(" ") { "%.2f".format(it) }}")
            println("RESULT impostor accepted ${impostor.count { it >= threshold }}/${impostor.size} mean ${"%.3f".format(impostor.average())} ${impostor.joinToString(" ") { "%.2f".format(it) }}")

            // The desktop measured: owner 11/12 (mean 0.887), other voice 0/12 (mean 0.516). The phone must agree closely.
            assertEquals(11.0, genuine.count { it >= threshold }.toDouble(), 1.0)
            assertTrue(impostor.count { it >= threshold } <= 1)
            assertEquals(0.887, genuine.average(), 0.04)
            assertEquals(0.516, impostor.average(), 0.04)

            // Very short clips and an unseen noisy owner clip
            val shortOwner = listOf("david-6-r0.wav", "david-7-r0.wav", "david-8-r0.wav").map { (store.verify(wav(it), strictness) as Verify.Result).score }
            val shortOther = listOf("zira-6-r0.wav", "zira-7-r0.wav", "zira-8-r0.wav").map { (store.verify(wav(it), strictness) as Verify.Result).score }
            println("RESULT short clips owner ${shortOwner.joinToString(" ") { "%.2f".format(it) }} | other ${shortOther.joinToString(" ") { "%.2f".format(it) }}")
            assertTrue(shortOther.none { it >= threshold })
            val noisy = (store.verify(Augment.noise(wav("david-n0-r0.wav"), 10.0, 99), strictness) as Verify.Result)
            println("RESULT owner at 10 dB noise score ${"%.2f".format(noisy.score)} owner=${noisy.owner}")
            assertTrue(noisy.owner)
        } finally { tmp.deleteRecursively(); embedder.close() }
    }
}
