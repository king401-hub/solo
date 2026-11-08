package com.solo.solo_android

import java.io.File
import kotlin.math.sqrt

/** Encryption for the stored voice print (Android Keystore on the phone; a fake in tests). */
interface Crypt {
    fun encrypt(plain: ByteArray): ByteArray?
    fun decrypt(data: ByteArray): ByteArray?
}

sealed class Verify {
    object NotEnrolled : Verify()
    object TooShort : Verify()
    data class Result(val score: Double, val owner: Boolean) : Verify()
}

data class VoiceIdStatus(val enrolled: Boolean, val createdAt: Long?, val pending: Int, val needed: Int, val encrypted: Boolean)
data class ClipResult(val ok: Boolean, val count: Int, val reason: String? = null)

/**
 * The owner's voice print on the phone: enrolment from several recordings, storage, verification. Mirrors
 * apps/desktop/src/main/voice/voiceId.ts. Only vectors are kept, never audio; stored encrypted with the Android Keystore,
 * on this phone only (never synced).
 */
class VoiceIdStore(private val file: File, private val embedder: Embedder, private val model: String, private val crypt: Crypt? = null) {
    companion object {
        const val MIN_CLIP_SECONDS = 3.0
        const val MIN_CLIP_LEVEL = 0.008
    }

    private var print: VoicePrintMath.Print? = null
    private val pending = mutableListOf<FloatArray>()
    private val pendingAug = mutableListOf<FloatArray>()
    private var encrypted = false

    init { load() }

    @Synchronized private fun load() {
        if (!file.exists()) return
        try {
            val raw = file.readBytes()
            val plain = if (crypt != null) crypt.decrypt(raw) else raw
            val p = plain?.let { VoicePrintMath.fromJson(String(it, Charsets.UTF_8)) } ?: return
            if (p.model == model) { print = p; encrypted = crypt != null }
        } catch (_: Exception) { /* unreadable or from another model: treated as not enrolled; the user re-records */ }
    }

    @Synchronized fun status() = VoiceIdStatus(print != null, print?.createdAt, pending.size, VoicePrintMath.MIN_ENROLL_CLIPS, encrypted)

    @Synchronized fun startEnrollment() { pending.clear(); pendingAug.clear() }
    @Synchronized fun cancelEnrollment() { pending.clear(); pendingAug.clear() }

    private fun rms(a: FloatArray): Double { var s = 0.0; for (x in a) s += x.toDouble() * x; return sqrt(s / maxOf(1, a.size)) }

    /** Add one recording (16 kHz mono) to the enrolment in progress. */
    @Synchronized fun addClip(pcm: FloatArray): ClipResult {
        if (pcm.size < MIN_CLIP_SECONDS * 16000) return ClipResult(false, pending.size, "That was too short. Read the whole sentence (at least ${MIN_CLIP_SECONDS.toInt()} seconds).")
        if (rms(pcm) < MIN_CLIP_LEVEL) return ClipResult(false, pending.size, "That was too quiet. Speak at your normal volume, close to the microphone.")
        val e = embedder.embed(pcm) ?: return ClipResult(false, pending.size, "Could not analyse that recording. Try again.")
        pending.add(e)
        for (v in Augment.variants(pcm)) embedder.embed(v)?.let { pendingAug.add(it) }
        return ClipResult(true, pending.size)
    }

    @Synchronized fun finishEnrollment(): Pair<Boolean, VoicePrintMath.Quality> {
        val (p, q) = VoicePrintMath.buildPrint(pending.toList(), model, pendingAug.toList())
        if (p != null) { print = p; save(p); pending.clear(); pendingAug.clear() }
        return (p != null) to q
    }

    private fun save(p: VoicePrintMath.Print) {
        file.parentFile?.mkdirs()
        val plain = VoicePrintMath.toJson(p).toByteArray(Charsets.UTF_8)
        val enc = crypt?.encrypt(plain)
        encrypted = enc != null
        val tmp = File(file.path + ".tmp")
        tmp.writeBytes(enc ?: plain)
        if (!tmp.renameTo(file)) { file.delete(); tmp.renameTo(file) }
    }

    fun verify(pcm: FloatArray, strictness: Double): Verify {
        val p = synchronized(this) { print } ?: return Verify.NotEnrolled
        val e = embedder.embed(pcm) ?: return Verify.TooShort
        val (score, owner) = VoicePrintMath.isOwner(p, e, strictness)
        return Verify.Result(score, owner)
    }

    @Synchronized fun reset() { print = null; pending.clear(); pendingAug.clear(); file.delete() }
}
