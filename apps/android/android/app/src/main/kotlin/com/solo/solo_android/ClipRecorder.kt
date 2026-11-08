package com.solo.solo_android

import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import kotlin.math.max
import kotlin.math.sqrt

/**
 * Records one spoken phrase from the microphone (16 kHz mono): waits for speech, stops after a pause. Used for voice
 * enrolment and "Test my voice". The wake-word service must not be holding the microphone at the same time.
 */
object ClipRecorder {
    private const val RATE = 16000
    private const val FRAME = 320 // 20 ms

    /** Returns the recording, or null if nothing was said before [maxSeconds] ran out (or the mic is unavailable). */
    fun record(maxSeconds: Int = 20): FloatArray? {
        val minBuf = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val rec = try {
            AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, max(minBuf, FRAME * 16))
        } catch (_: SecurityException) { return null }
        if (rec.state != AudioRecord.STATE_INITIALIZED) { rec.release(); return null }
        val out = ArrayList<ShortArray>()
        val buf = ShortArray(FRAME)
        var voicedRun = 0; var started = false; var quietMs = 0; var floor = 0.004
        val maxFrames = maxSeconds * 1000 / 20
        val prerollFrames = 15
        try {
            rec.startRecording()
            var frames = 0
            while (frames++ < maxFrames) {
                var got = 0
                while (got < FRAME) { val n = rec.read(buf, got, FRAME - got); if (n <= 0) return if (started) toFloats(out) else null; got += n }
                var s = 0.0; for (x in buf) { val f = x / 32768.0; s += f * f }
                val level = sqrt(s / FRAME)
                val voiced = level > max(0.015, floor * 3)
                if (!started) {
                    floor = floor * 0.95 + level * 0.05 // learn the room's background level while waiting
                    out.add(buf.copyOf()); if (out.size > prerollFrames) out.removeAt(0)
                    voicedRun = if (voiced) voicedRun + 1 else 0
                    if (voicedRun >= 5) started = true
                } else {
                    out.add(buf.copyOf())
                    quietMs = if (voiced) 0 else quietMs + 20
                    if (quietMs >= 900) break
                }
            }
            return if (started) toFloats(out) else null
        } finally {
            try { rec.stop() } catch (_: IllegalStateException) {}
            rec.release()
        }
    }

    private fun toFloats(frames: List<ShortArray>): FloatArray {
        val n = frames.sumOf { it.size }
        val a = FloatArray(n); var o = 0
        for (f in frames) for (x in f) a[o++] = x / 32768f
        return a
    }
}
