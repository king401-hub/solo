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
import android.media.AudioFormat
import android.media.AudioFocusRequest
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
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * Always-on wake-word listener that runs without any UI.
 *
 * Stage 1 (cheap): a Vosk recognizer restricted to the wake grammar watches the microphone.
 * Stage 2 (verify): when stage 1 fires, the last ~3 s of audio plus the live audio go to a full-vocabulary recognizer;
 *   only if that transcript really starts with a wake phrase (WakeMatcher) does Solo respond. This rejects the
 *   false triggers a tiny grammar recognizer is prone to.
 * Solo answers by voice from this service. It never starts an Activity, so the app is not brought forward.
 *
 * Privacy: all recognition is offline on the phone; audio is never stored or sent anywhere. Audio is discarded while
 * Solo is speaking so it does not hear itself. Android shows its microphone indicator whenever this runs.
 *
 * Limits (Android): this is a foreground service of type "microphone", so it needs RECORD_AUDIO, shows a notification,
 * must be started while the app is visible (Android 14+), cannot be started at boot, and stops if the user force-stops
 * the app. Some vendors (Huawei/EMUI) additionally need "run in background" allowed for the app.
 */
class WakeService : Service() {
    companion object {
        private const val TAG = "SoloWake"
        const val ACTION_STOP = "com.solo.solo_android.WAKE_STOP"
        private const val CHANNEL = "solo_wake"
        private const val NOTIF_ID = 411
        private const val RATE = 16000
        private const val PREFS = "solo_wake"
        private const val GRAMMAR = """["hey solo","hi solo","solo","hey solomon","hi solomon","solomon","[unk]"]"""

        @Volatile var running = false

        fun start(ctx: Context) = ContextCompat.startForegroundService(ctx, Intent(ctx, WakeService::class.java))
        fun stop(ctx: Context) { ctx.startService(Intent(ctx, WakeService::class.java).setAction(ACTION_STOP)) }

        /** Last things heard (newest first) for the app's Settings screen. */
        fun recent(ctx: Context): JSONArray =
            try { JSONArray(ctx.getSharedPreferences(PREFS, MODE_PRIVATE).getString("heard", "[]")) } catch (_: Exception) { JSONArray() }

        fun wantsRunning(ctx: Context) = ctx.getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean("enabled", false)
        fun setWanted(ctx: Context, on: Boolean) = ctx.getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean("enabled", on).apply()
    }

    private enum class State { WAKE, VERIFY, FOLLOW_UP }

    @Volatile private var stopped = false
    @Volatile private var speaking = false
    private var worker: Thread? = null
    private var tts: TextToSpeech? = null
    private var ttsReady = false
    private val audio by lazy { getSystemService(Context.AUDIO_SERVICE) as AudioManager }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            setWanted(this, false)
            shutdown()
            return START_NOT_STICKY
        }
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
                override fun onDone(id: String?) { finishSpeaking() }
                @Deprecated("deprecated in API") override fun onError(id: String?) { finishSpeaking() }
            })
            ttsReady = true
        }
    }

    private var focus: AudioFocusRequest? = null
    private fun finishSpeaking() {
        focus?.let { audio.abandonAudioFocusRequest(it) }
        // small tail so the end of our own voice is not mistaken for the user
        Thread.sleep(250)
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

    private fun say(text: String) {
        val t = tts
        if (t == null || !ttsReady) { Log.w(TAG, "TTS not ready, cannot say: $text"); return }
        speaking = true
        t.setSpeechRate(rate())
        pickVoice(t, gender())
        val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
            .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANT).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
            .build()
        focus = req
        audio.requestAudioFocus(req)
        t.speak(text, TextToSpeech.QUEUE_FLUSH, null, "solo-${System.nanoTime()}")
    }

    private fun remember(text: String, accepted: Boolean) {
        val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
        val list = JSONArray()
        list.put(JSONObject().put("t", System.currentTimeMillis()).put("text", text).put("accepted", accepted))
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
        var state = State.WAKE
        var stateStart = 0L
        var windowMs = 10_000L
        rec.startRecording()
        Log.i(TAG, "listening")
        try {
            while (!stopped) {
                val n = rec.read(buf, 0, buf.size)
                if (n <= 0) continue
                if (speaking) { // never listen to ourselves; the follow-up window starts once Solo has finished talking
                    kw.reset(); ringFilled = 0
                    if (state != State.WAKE) stateStart = System.currentTimeMillis()
                    continue
                }
                when (state) {
                    State.WAKE -> {
                        for (i in 0 until n) { ring[ringPos] = buf[i]; ringPos = (ringPos + 1) % ring.size }
                        ringFilled = minOf(ring.size, ringFilled + n)
                        val triggered = if (kw.acceptWaveForm(buf, n)) {
                            WakeMatcher.match(textOf(kw.result, "text"), true).matched
                        } else {
                            WakeMatcher.match(textOf(kw.partialResult, "partial"), true).matched
                        }
                        if (triggered) {
                            Log.i(TAG, "stage-1 trigger; verifying")
                            full.reset(); kw.reset()
                            // replay buffered audio in time order
                            val start = (ringPos - ringFilled + ring.size) % ring.size
                            val replay = ShortArray(ringFilled) { ring[(start + it) % ring.size] }
                            full.acceptWaveForm(replay, replay.size)
                            ringFilled = 0
                            state = State.VERIFY; stateStart = System.currentTimeMillis(); windowMs = 10_000L
                        }
                    }
                    State.VERIFY, State.FOLLOW_UP -> {
                        val ended = full.acceptWaveForm(buf, n)
                        val timeout = System.currentTimeMillis() - stateStart > windowMs
                        if (ended || timeout) {
                            val text = textOf(if (ended) full.result else full.finalResult, "text").trim()
                            full.reset(); kw.reset()
                            val wasFollowUp = state == State.FOLLOW_UP
                            state = State.WAKE
                            if (text.isEmpty()) continue
                            val m = if (wasFollowUp) WakeMatcher.Match(true, text) else WakeMatcher.match(text, quick())
                            remember(text, m.matched)
                            if (!m.matched) { Log.i(TAG, "rejected after verify: $text"); continue }
                            if (m.rest.isEmpty()) {
                                say("Yes?")
                                state = State.FOLLOW_UP; stateStart = System.currentTimeMillis(); windowMs = maxOf(followUpMs(), 8_000L)
                            } else {
                                // Phase 4 will route this to the AI; until then Solo confirms what it understood.
                                say("I heard: ${m.rest}")
                                if (followUpMs() > 0) { state = State.FOLLOW_UP; stateStart = System.currentTimeMillis(); windowMs = followUpMs() }
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
