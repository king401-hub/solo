package com.solo.solo_android

import android.Manifest
import android.content.pm.PackageManager
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.util.concurrent.Executors

/** Bridge for the on-phone wake-word listener and voice recognition. The listener itself lives in [WakeService]. */
class MainActivity : FlutterActivity() {
    private val micRequest = 7101
    private var pending: MethodChannel.Result? = null
    private val worker = Executors.newSingleThreadExecutor() // model loading, embedding and recording never run on the UI thread

    private fun micGranted() =
        ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "solo/wake").setMethodCallHandler { call, result -> handle(call, result) }
    }

    /** Runs [block] off the UI thread and returns its value (or the error text) to Dart. */
    private fun async(result: MethodChannel.Result, block: () -> Any?) {
        worker.execute {
            val out = try { block() } catch (e: Throwable) { mapOf("ok" to false, "reason" to (e.message ?: e.toString())) }
            runOnUiThread { result.success(out) }
        }
    }

    /** The microphone is single-owner: free it from the wake-word listener, run [block], then resume listening. */
    private fun <T> withMicFree(block: () -> T): T {
        val wasRunning = WakeService.running
        if (wasRunning) {
            WakeService.pause(this)
            val end = System.currentTimeMillis() + 4000
            while (WakeService.running && System.currentTimeMillis() < end) Thread.sleep(50)
            Thread.sleep(150)
        }
        try { return block() } finally { if (wasRunning) runOnUiThread { WakeService.start(this) } }
    }

    private fun handle(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "status" -> result.success(mapOf(
                "running" to WakeService.running,
                "wanted" to WakeService.wantsRunning(this),
                "micGranted" to micGranted(),
                "recent" to WakeService.recent(this).toString(),
            ))
            "start" -> {
                if (micGranted()) { WakeService.start(this); result.success("started"); return }
                if (pending != null) { result.success("busy"); return }
                pending = result
                ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.RECORD_AUDIO), micRequest)
            }
            "stop" -> { WakeService.stop(this); result.success("stopped") }

            // ---- owner's voice ----
            "voice.status" -> async(result) {
                val s = VoiceId.store(this).status()
                mapOf("enrolled" to s.enrolled, "createdAt" to s.createdAt, "pending" to s.pending, "needed" to s.needed, "encrypted" to s.encrypted)
            }
            "voice.warmup" -> async(result) { VoiceId.warmup(this).let { if (it == null) mapOf("ok" to true) else mapOf("ok" to false, "error" to it) } }
            "voice.enrollStart" -> async(result) { VoiceId.store(this).startEnrollment(); mapOf("ok" to true) }
            "voice.enrollCancel" -> async(result) { VoiceId.store(this).cancelEnrollment(); mapOf("ok" to true) }
            "voice.enrollRecord" -> async(result) {
                if (!micGranted()) return@async mapOf("ok" to false, "count" to 0, "reason" to "Solo needs the microphone permission first.")
                VoiceId.warmup(this)?.let { return@async mapOf("ok" to false, "count" to 0, "reason" to "The voice model could not load: $it") }
                val pcm = withMicFree { ClipRecorder.record(20) } ?: return@async mapOf("ok" to false, "count" to VoiceId.store(this).status().pending, "reason" to "I did not hear anything. Check the microphone and try again.")
                val r = VoiceId.store(this).addClip(pcm)
                mapOf("ok" to r.ok, "count" to r.count, "reason" to r.reason)
            }
            "voice.enrollFinish" -> async(result) {
                val (ok, q) = VoiceId.store(this).finishEnrollment()
                mapOf("ok" to ok, "quality" to mapOf("ok" to q.ok, "clips" to q.clips, "minAgreement" to q.minAgreement, "meanAgreement" to q.meanAgreement, "reason" to q.reason))
            }
            "voice.test" -> async(result) {
                val cfg = VoiceId.config(this)
                val threshold = VoicePrintMath.thresholdFor(cfg.strictness)
                if (!micGranted()) return@async mapOf("note" to "Solo needs the microphone permission first.", "threshold" to threshold)
                VoiceId.warmup(this)?.let { return@async mapOf("note" to it, "threshold" to threshold) }
                val pcm = withMicFree { ClipRecorder.record(15) } ?: return@async mapOf("note" to "I did not hear anything.", "threshold" to threshold)
                when (val v = VoiceId.store(this).verify(pcm, cfg.strictness)) {
                    is Verify.NotEnrolled -> mapOf("note" to "No voice print yet.", "threshold" to threshold)
                    is Verify.TooShort -> mapOf("note" to "That was too short to judge. Say a full sentence.", "threshold" to threshold)
                    is Verify.Result -> mapOf("score" to v.score, "owner" to v.owner, "threshold" to threshold)
                }
            }
            "voice.reset" -> async(result) { VoiceId.store(this).reset(); mapOf("ok" to true) }
            "voice.getConfig" -> async(result) {
                val c = VoiceId.config(this)
                mapOf("onlyMyVoice" to c.onlyMyVoice, "greetingsWake" to c.greetingsWake, "allowInterrupt" to c.allowInterrupt, "strictness" to c.strictness, "threshold" to VoicePrintMath.thresholdFor(c.strictness))
            }
            "voice.setConfig" -> async(result) { VoiceId.setConfig(this, (call.arguments as? Map<*, *>) ?: emptyMap<Any, Any>()); mapOf("ok" to true) }
            "voice.getCorrections" -> async(result) { VoiceId.corrections(this).map { mapOf("heard" to it.heard, "meant" to it.meant) } }
            "voice.setCorrections" -> async(result) {
                val list = (call.arguments as? List<*>)?.mapNotNull { (it as? Map<*, *>)?.let { m -> Language.Correction(m["heard"].toString(), m["meant"].toString()) } } ?: emptyList()
                VoiceId.setCorrections(this, list); mapOf("ok" to true)
            }
            else -> result.notImplemented()
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != micRequest) return
        val ok = grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED
        if (ok) WakeService.start(this)
        pending?.success(if (ok) "started" else "denied")
        pending = null
    }
}
