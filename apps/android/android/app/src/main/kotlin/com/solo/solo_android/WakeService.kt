package com.solo.solo_android

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import android.os.IBinder
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import org.vosk.LibVosk
import org.vosk.LogLevel
import org.vosk.Model
import org.vosk.Recognizer
import org.vosk.android.StorageService
import java.io.IOException
import java.util.Locale
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread
import kotlin.math.sqrt

/**
 * Always-on wake-word listener that runs without any UI.
 *
 * Stage 1 (cheap): a Vosk recognizer restricted to the wake grammar (and, for an enrolled owner, greeting words) watches
 *   the microphone.
 * Stage 2 (verify): when stage 1 fires, the last ~3 s of audio plus the live audio go to a full-vocabulary recognizer;
 *   the transcript must really start with a wake phrase (or, for the owner, a greeting) before Solo responds.
 * Stage 3 (owner, only if a voice print exists): the same audio is checked against the owner's voice print. With "only
 *   my voice" on, anything that is not verifiably the owner is ignored; the owner's greetings need no wake word.
 * Solo answers by voice from this service. It never starts an Activity, so the app is not brought forward.
 *
 * Solo never listens to itself: audio is discarded while it speaks. The only exception is an enrolled owner who allowed
 * interruption: sustained speech is checked against the voice print, so the owner can stop Solo but its own voice cannot.
 *
 * Privacy: all recognition is offline on the phone; audio is never stored or sent anywhere. Android shows its microphone
 * indicator whenever this runs.
 *
 * Limits (Android): foreground service of type "microphone": needs RECORD_AUDIO, shows a notification, must be started
 * while the app is visible (Android 14+), cannot be started at boot, stops if the user force-stops the app. Some vendors
 * (Huawei/EMUI) additionally need "run in background" allowed for the app.
 */
class WakeService : Service() {
    companion object {
        private const val TAG = "SoloWake"
        const val ACTION_STOP = "com.solo.solo_android.WAKE_STOP"
        /** Stop listening for now (e.g. so the microphone is free for enrolment) without turning the feature off. */
        const val ACTION_PAUSE = "com.solo.solo_android.WAKE_PAUSE"
        private const val CHANNEL = "solo_wake"
        private const val NOTIF_ID = 411
        private const val RATE = 16000
        private const val PREFS = "solo_wake"
        private const val GRAMMAR = """["hey solo","hi solo","solo","hey solomon","hi solomon","solomon","hello","hi","good morning","good afternoon","good evening","good night","how far","[unk]"]"""
        private const val TAIL_MS = 600L // ignore the microphone briefly after Solo stops talking
        private const val INTERRUPT_MIN_MS = 900L
        private const val INTERRUPT_CHECK_EVERY_MS = 1500L

        @Volatile var running = false

        fun start(ctx: Context) = ContextCompat.startForegroundService(ctx, Intent(ctx, WakeService::class.java))
        fun stop(ctx: Context) { ctx.startService(Intent(ctx, WakeService::class.java).setAction(ACTION_STOP)) }
        fun pause(ctx: Context) { ctx.startService(Intent(ctx, WakeService::class.java).setAction(ACTION_PAUSE)) }

        /** Last things heard (newest first) for the app's Settings screen. */
        fun recent(ctx: Context): JSONArray =
            try { JSONArray(ctx.getSharedPreferences(PREFS, MODE_PRIVATE).getString("heard", "[]")) } catch (_: Exception) { JSONArray() }

        fun wantsRunning(ctx: Context) = ctx.getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean("enabled", false)
        fun setWanted(ctx: Context, on: Boolean) = ctx.getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean("enabled", on).apply()

        /** Splits a reply into sentence-sized pieces so one long utterance cannot be cut off and a stop takes effect quickly. */
        fun splitForSpeech(text: String, maxLen: Int = 220): List<String> {
            val sentences = Regex("[^.!?;:\\n]+[.!?;:]*\\s*").findAll(text.replace(Regex("\\s+"), " ").trim()).map { it.value }.toList()
            val out = ArrayList<String>(); var cur = ""
            for (s in sentences) {
                if (cur.length + s.length > maxLen && cur.isNotEmpty()) { out.add(cur.trim()); cur = "" }
                if (s.length > maxLen) {
                    for (part0 in s.split(Regex("(?<=,)\\s+"))) {
                        var part = part0
                        while (part.length > maxLen) {
                            val cut = part.lastIndexOf(' ', maxLen); val at = if (cut > maxLen / 2) cut else maxLen
                            if (cur.isNotEmpty()) { out.add(cur.trim()); cur = "" }
                            out.add(part.substring(0, at).trim()); part = part.substring(at).trim()
                        }
                        if (cur.length + part.length > maxLen && cur.isNotEmpty()) { out.add(cur.trim()); cur = "" }
                        cur += "$part "
                    }
                } else cur += s
            }
            if (cur.isNotBlank()) out.add(cur.trim())
            return out
        }
    }

    private enum class State { WAKE, VERIFY, FOLLOW_UP }

    @Volatile private var stopped = false
    @Volatile private var speaking = false
    @Volatile private var interruptRequested = false
    @Volatile private var muteUntil = 0L
    private var worker: Thread? = null
    private var tts: TextToSpeech? = null
    private var ttsReady = false
    private val pendingPieces = AtomicInteger(0)
    private val audio by lazy { getSystemService(Context.AUDIO_SERVICE) as AudioManager }
    private val verifier = Executors.newSingleThreadExecutor()

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            setWanted(this, false)
            shutdown()
            return START_NOT_STICKY
        }
        if (intent?.action == ACTION_PAUSE) { shutdown(); return START_NOT_STICKY } // stays wanted: the app restarts it
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            Log.w(TAG, "RECORD_AUDIO not granted; not starting")
            shutdown()
            return START_NOT_STICKY
        }
        if (running) return START_STICKY
        try { startInForeground() } catch (e: Exception) { // e.g. Android refuses a microphone service started from the background
            Log.w(TAG, "cannot start foreground: ${e.message}"); shutdown(); return START_NOT_STICKY
        }
        running = true
        setWanted(this, true)
        initTts()
        worker = thread(name = "solo-wake") { runLoop() }
        return START_STICKY
    }

    override fun onDestroy() {
        stopped = true
        running = false
        tts?.shutdown()
        verifier.shutdownNow()
        super.onDestroy()
    }

    private fun shutdown() {
        stopped = true
        running = false
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun startInForeground() {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "Solo wake word", NotificationManager.IMPORTANCE_LOW))
        }
        val stop = PendingIntent.getService(
            this, 0, Intent(this, WakeService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val n: Notification = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("Solo is listening")
            .setContentText("Say \"Hey Solo\". Audio stays on this phone.")
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .addAction(0, "Stop listening", stop)
            .build()
        val type = if (Build.VERSION.SDK_INT >= 30) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0
        ServiceCompat.startForeground(this, NOTIF_ID, n, type)
    }

    // ---- settings synced from the desktop (written by the Dart link service into Flutter's prefs) ----

    private fun config(): JSONObject = try {
        val p = getSharedPreferences("FlutterSharedPreferences", MODE_PRIVATE)
        JSONObject(p.getString("flutter.solo_voice_config", "{}") ?: "{}")
    } catch (_: Exception) { JSONObject() }

    private fun quick() = config().optBoolean("quickWord", true)
    private fun gender() = config().optString("voiceGender", "female")
    private fun rate() = config().optDouble("speechRate", 1.0).toFloat().coerceIn(0.5f, 2f)
    private fun followUpMs() = config().optInt("followUpSeconds", 12).coerceIn(0, 60) * 1000L

    // ---- speech output ----

    private fun initTts() {
        tts = TextToSpeech(applicationContext) { status ->
            val t = tts ?: return@TextToSpeech
            if (status != TextToSpeech.SUCCESS) { Log.w(TAG, "TTS init failed: $status"); return@TextToSpeech }
            t.language = Locale.US
            t.setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANT).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
            t.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                override fun onStart(id: String?) {}
                override fun onDone(id: String?) { if (pendingPieces.decrementAndGet() <= 0) finishSpeaking() }
                @Deprecated("deprecated in API") override fun onError(id: String?) { if (pendingPieces.decrementAndGet() <= 0) finishSpeaking() }
            })
            ttsReady = true
        }
    }

    private var focus: AudioFocusRequest? = null
    private fun finishSpeaking() {
        focus?.let { audio.abandonAudioFocusRequest(it) }
        muteUntil = System.currentTimeMillis() + TAIL_MS // the end of our own voice must not be mistaken for the user
        speaking = false
    }

    private fun pickVoice(t: TextToSpeech, gender: String) {
        if (gender == "any") return
        val en = t.voices?.filter { it.locale.language == "en" && !it.isNetworkConnectionRequired } ?: return
        val female = en.firstOrNull { it.name.contains("female", true) || Regex("-(sfg|tpf|tpc|iob|enc|end)-").containsMatchIn(it.name) }
        val male = en.firstOrNull { it.name.contains("male", true) && !it.name.contains("female", true) || Regex("-(iol|iom|tpd)-").containsMatchIn(it.name) }
        val v = if (gender == "female") female else male
        if (v != null) t.voice = v else t.setPitch(if (gender == "female") 1.15f else 0.9f)
    }

    /** Solo's own name is never spoken back: the microphone could hear it and treat it as a new wake word. */
    private fun sanitize(text: String) = text.replace(Regex("\\b(hey|hi|hay|okay|ok)?\\s*solo(mon)?\\b", RegexOption.IGNORE_CASE), " ").replace(Regex("\\s+"), " ").trim()

    private fun say(text: String) {
        val t = tts
        if (t == null || !ttsReady) { Log.w(TAG, "TTS not ready, cannot say: $text"); return }
        val pieces = splitForSpeech(text)
        if (pieces.isEmpty()) return
        speaking = true
        interruptRequested = false
        t.setSpeechRate(rate())
        pickVoice(t, gender())
        val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
            .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANT).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
            .build()
        focus = req
        audio.requestAudioFocus(req)
        pendingPieces.set(pieces.size)
        pieces.forEachIndexed { i, p -> t.speak(p, if (i == 0) TextToSpeech.QUEUE_FLUSH else TextToSpeech.QUEUE_ADD, null, "solo-${System.nanoTime()}-$i") }
    }

    private fun stopSpeaking() {
        tts?.stop()
        pendingPieces.set(0)
        finishSpeaking()
    }

    private fun remember(text: String, accepted: Boolean, owner: Boolean?, score: Double?) {
        val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
        val list = JSONArray()
        val e = JSONObject().put("t", System.currentTimeMillis()).put("text", text).put("accepted", accepted)
        if (owner != null) e.put("owner", owner)
        if (score != null) e.put("score", score)
        list.put(e)
        val old = recent(this)
        for (i in 0 until minOf(old.length(), 9)) list.put(old.get(i))
        prefs.edit().putString("heard", list.toString()).apply()
    }

    // ---- recognition loop ----

    private fun loadModel(): Model? {
        val latch = CountDownLatch(1)
        var model: Model? = null
        StorageService.unpack(this, "model-en-us", "model",
            { m: Model -> model = m; latch.countDown() },
            { e: IOException -> Log.e(TAG, "model unpack failed", e); latch.countDown() })
        latch.await(120, TimeUnit.SECONDS)
        return model
    }

    private fun textOf(json: String, key: String) = try { JSONObject(json).optString(key, "") } catch (_: Exception) { "" }

    private fun rms(a: ShortArray, n: Int): Double { var s = 0.0; for (i in 0 until n) { val f = a[i] / 32768.0; s += f * f }; return sqrt(s / maxOf(1, n)) }
    private fun toFloats(parts: List<ShortArray>): FloatArray { val n = parts.sumOf { it.size }; val a = FloatArray(n); var o = 0; for (p in parts) for (x in p) a[o++] = x / 32768f; return a }

    private data class OwnerCheck(val owner: Boolean?, val score: Double?)

    /** Is this audio the enrolled owner? null = not enrolled or too short to judge (treated as "not verified"). */
    private fun checkOwner(parts: List<ShortArray>, strictness: Double): OwnerCheck {
        return try {
            when (val v = VoiceId.store(this).verify(toFloats(parts), strictness)) {
                is Verify.Result -> OwnerCheck(v.owner, v.score)
                else -> OwnerCheck(null, null)
            }
        } catch (e: Throwable) { Log.w(TAG, "owner check failed: ${e.message}"); OwnerCheck(null, null) }
    }

    private fun runLoop() {
        LibVosk.setLogLevel(LogLevel.WARNINGS)
        val model = loadModel() ?: run { Log.e(TAG, "no model; stopping"); shutdown(); return }
        val kw = Recognizer(model, RATE.toFloat(), GRAMMAR)
        val full = Recognizer(model, RATE.toFloat())
        val minBuf = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val chunk = 3200 // 200 ms
        val rec = try {
            AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, RATE, AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT, maxOf(minBuf, chunk * 4))
        } catch (e: SecurityException) { Log.e(TAG, "mic denied", e); shutdown(); return }
        if (rec.state != AudioRecord.STATE_INITIALIZED) { Log.e(TAG, "AudioRecord not initialised"); shutdown(); return }

        val ring = ShortArray(RATE * 3) // last 3 s, so a same-breath request ("Hey Solo, what time is it") is not lost
        var ringPos = 0; var ringFilled = 0
        val buf = ShortArray(chunk)
        val utt = ArrayList<ShortArray>() // the audio being recognised, for the owner check
        var state = State.WAKE
        var stateStart = 0L
        var windowMs = 10_000L

        // interruption watch while Solo speaks
        val intFrames = ArrayDeque<ShortArray>(); var intMs = 0L; var lastIntCheck = 0L
        val checkingInterrupt = AtomicBoolean(false)

        rec.startRecording()
        Log.i(TAG, "listening")
        try {
            while (!stopped) {
                val n = rec.read(buf, 0, buf.size)
                if (n <= 0) continue
                val now = System.currentTimeMillis()

                if (interruptRequested) { // the owner talked over Solo
                    interruptRequested = false
                    stopSpeaking(); full.reset(); kw.reset(); utt.clear(); intFrames.clear(); intMs = 0
                    state = State.FOLLOW_UP; stateStart = now; windowMs = 8_000L
                    continue
                }

                if (speaking || now < muteUntil) {
                    // never listen to ourselves; the follow-up window starts once Solo has finished talking
                    kw.reset(); ringFilled = 0
                    if (state != State.WAKE) stateStart = now
                    val cfg = VoiceId.config(this)
                    if (speaking && cfg.allowInterrupt && VoiceId.store(this).status().enrolled) {
                        // watch for sustained speech and verify it is the owner before stopping Solo
                        if (rms(buf, n) > 0.03) {
                            intFrames.addLast(buf.copyOf(n)); intMs += n * 1000L / RATE
                            while (intFrames.size > 8) { val f = intFrames.removeFirst(); intMs -= f.size * 1000L / RATE }
                            if (intMs >= INTERRUPT_MIN_MS && now - lastIntCheck >= INTERRUPT_CHECK_EVERY_MS && checkingInterrupt.compareAndSet(false, true)) {
                                lastIntCheck = now
                                val clip = intFrames.toList()
                                verifier.execute {
                                    try { if (speaking && checkOwner(clip, cfg.strictness).owner == true) interruptRequested = true } finally { checkingInterrupt.set(false) }
                                }
                            }
                        } else { intFrames.clear(); intMs = 0 }
                    }
                    continue
                }
                intFrames.clear(); intMs = 0

                when (state) {
                    State.WAKE -> {
                        for (i in 0 until n) { ring[ringPos] = buf[i]; ringPos = (ringPos + 1) % ring.size }
                        ringFilled = minOf(ring.size, ringFilled + n)
                        val cfg = VoiceId.config(this)
                        val greetingsOn = cfg.greetingsWake && VoiceId.store(this).status().enrolled
                        val text1 = if (kw.acceptWaveForm(buf, n)) textOf(kw.result, "text") else textOf(kw.partialResult, "partial")
                        val triggered = WakeMatcher.match(text1, true).matched || (greetingsOn && Language.matchGreeting(text1) != null)
                        if (triggered) {
                            Log.i(TAG, "stage-1 trigger; verifying")
                            full.reset(); kw.reset()
                            // replay buffered audio in time order
                            val start = (ringPos - ringFilled + ring.size) % ring.size
                            val replay = ShortArray(ringFilled) { ring[(start + it) % ring.size] }
                            full.acceptWaveForm(replay, replay.size)
                            utt.clear(); utt.add(replay)
                            ringFilled = 0
                            state = State.VERIFY; stateStart = now; windowMs = 10_000L
                        }
                    }
                    State.VERIFY, State.FOLLOW_UP -> {
                        utt.add(buf.copyOf(n))
                        val ended = full.acceptWaveForm(buf, n)
                        val timeout = now - stateStart > windowMs
                        if (ended || timeout) {
                            val raw = textOf(if (ended) full.result else full.finalResult, "text").trim()
                            full.reset(); kw.reset()
                            val wasFollowUp = state == State.FOLLOW_UP
                            val heard = ArrayList(utt); utt.clear()
                            state = State.WAKE
                            if (raw.isEmpty()) continue
                            val text = Language.applyCorrections(raw, VoiceId.corrections(this))
                            val cfg = VoiceId.config(this)
                            val enrolled = VoiceId.store(this).status().enrolled
                            val oc = if (enrolled) checkOwner(heard, cfg.strictness) else OwnerCheck(null, null)

                            // With a voice print and "only my voice" on, anything not verifiably the owner is ignored outright.
                            if (enrolled && cfg.onlyMyVoice && oc.owner != true) { remember(text, false, oc.owner ?: false, oc.score); Log.i(TAG, "ignored (not the owner): $text"); continue }

                            val w = if (wasFollowUp) WakeMatcher.Match(true, text) else WakeMatcher.match(text, quick())
                            val g = if (!w.matched && !wasFollowUp && enrolled && cfg.greetingsWake && oc.owner == true) Language.matchGreeting(text) else null
                            remember(text, w.matched || g != null, oc.owner, oc.score)
                            if (!w.matched && g == null) { Log.i(TAG, "rejected after verify: $text"); continue }
                            val rest = if (g != null) g.rest else w.rest
                            if (rest.isEmpty()) {
                                say(if (g != null) Language.greetingReply(g.kind) else "Yes?")
                                state = State.FOLLOW_UP; stateStart = now; windowMs = maxOf(followUpMs(), 8_000L)
                            } else {
                                // Phase 4 will route this to the AI; until then Solo confirms what it understood.
                                say("I heard: ${sanitize(rest).ifEmpty { "you" }}")
                                if (followUpMs() > 0) { state = State.FOLLOW_UP; stateStart = now; windowMs = followUpMs() }
                            }
                        }
                    }
                }
            }
        } finally {
            try { rec.stop() } catch (_: IllegalStateException) {}
            rec.release(); kw.close(); full.close(); model.close()
            Log.i(TAG, "stopped")
        }
    }
}
