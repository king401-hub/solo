package com.solo.solo_android

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.OpenableColumns
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.content.IntentCompat
import java.io.File
import java.util.UUID
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
    private val pickRequest = 7102
    private var pickResult: MethodChannel.Result? = null
    private val shared = java.util.Collections.synchronizedList(mutableListOf<Map<String, Any>>()) // files other apps shared to Solo, staged for sending

    /** Files are copied out of the content:// Uri into the app cache so the sending isolate can read them as plain files. */
    private fun outgoingDir() = File(cacheDir, "outgoing").apply { mkdirs() }

    private fun stage(uri: Uri): Map<String, Any>? = try {
        var name = "file"
        var size = -1L
        contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
            if (c.moveToFirst()) {
                c.getString(0)?.let { name = it }
                if (!c.isNull(1)) size = c.getLong(1)
            }
        }
        name = name.substringAfterLast('/').substringAfterLast("\\").ifBlank { "file" }
        val dir = File(outgoingDir(), UUID.randomUUID().toString()).apply { mkdirs() }
        val out = File(dir, name)
        contentResolver.openInputStream(uri)?.use { input -> out.outputStream().use { input.copyTo(it) } } ?: throw IllegalStateException("cannot open")
        mapOf("path" to out.absolutePath, "name" to name, "size" to out.length())
    } catch (e: Exception) { null }

    private fun takeSharedIntent(i: Intent?) {
        if (i == null) return
        val uris = when (i.action) {
            Intent.ACTION_SEND -> listOfNotNull(IntentCompat.getParcelableExtra(i, Intent.EXTRA_STREAM, Uri::class.java))
            Intent.ACTION_SEND_MULTIPLE -> IntentCompat.getParcelableArrayListExtra(i, Intent.EXTRA_STREAM, Uri::class.java) ?: emptyList()
            else -> return
        }
        i.action = null // handle once
        if (uris.isNotEmpty()) worker.execute { uris.forEach { u -> stage(u)?.let { shared.add(it) } } }
    }

    private fun sweepOutgoing() = worker.execute {
        val old = System.currentTimeMillis() - 24 * 3600_000L
        outgoingDir().listFiles()?.filter { it.lastModified() < old }?.forEach { it.deleteRecursively() }
    }

    /** Received files live in the app's private files folder. Tell the Dart side (which receives them in the background service). */
    private fun incomingDir() = File(filesDir, "incoming").apply { mkdirs() }

    private fun inIncoming(f: File) = f.canonicalFile.path.startsWith(incomingDir().canonicalFile.path + File.separator)

    private fun mimeOf(name: String): String =
        android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substringAfterLast('.', "").lowercase()) ?: "application/octet-stream"

    private val storageRequest = 7103

    /** Copies a received file to the public Downloads/Solo folder. */
    private fun saveToDownloads(src: File, name: String): Map<String, Any> {
        if (!src.exists() || !inIncoming(src)) return mapOf("ok" to false, "reason" to "That file is no longer on the phone.")
        if (android.os.Build.VERSION.SDK_INT >= 29) {
            val values = android.content.ContentValues().apply {
                put(android.provider.MediaStore.MediaColumns.DISPLAY_NAME, name)
                put(android.provider.MediaStore.MediaColumns.MIME_TYPE, mimeOf(name))
                put(android.provider.MediaStore.MediaColumns.RELATIVE_PATH, "Download/Solo")
            }
            val uri = contentResolver.insert(android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                ?: return mapOf("ok" to false, "reason" to "The phone would not create the file in Downloads.")
            contentResolver.openOutputStream(uri)?.use { out -> src.inputStream().use { it.copyTo(out) } }
            return mapOf("ok" to true, "where" to "Downloads/Solo")
        }
        // Android 9 and older: needs the storage permission.
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
            runOnUiThread { ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.WRITE_EXTERNAL_STORAGE), storageRequest) }
            return mapOf("ok" to false, "reason" to "Allow storage access when the phone asks, then tap Save to Downloads again.")
        }
        val dir = File(android.os.Environment.getExternalStoragePublicDirectory(android.os.Environment.DIRECTORY_DOWNLOADS), "Solo").apply { mkdirs() }
        var dest = File(dir, name)
        var i = 1
        while (dest.exists()) { dest = File(dir, "${name.substringBeforeLast('.')} (${i++}).${name.substringAfterLast('.', "")}".trimEnd('.')) }
        src.copyTo(dest)
        android.media.MediaScannerConnection.scanFile(this, arrayOf(dest.absolutePath), null, null)
        return mapOf("ok" to true, "where" to "Downloads/Solo")
    }

    private fun openFile(f: File): Map<String, Any> {
        if (!f.exists() || !inIncoming(f)) return mapOf("ok" to false, "reason" to "That file is no longer on the phone.")
        val uri = androidx.core.content.FileProvider.getUriForFile(this, "$packageName.files", f)
        val view = Intent(Intent.ACTION_VIEW).apply { setDataAndType(uri, mimeOf(f.name)); addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION) }
        return try { runOnUiThread { startActivity(Intent.createChooser(view, f.name)) }; mapOf("ok" to true) }
        catch (e: Exception) { mapOf("ok" to false, "reason" to "No app on this phone can open that kind of file. Try Save to Downloads.") }
    }

    override fun onCreate(savedInstanceState: android.os.Bundle?) {
        super.onCreate(savedInstanceState)
        getSharedPreferences("FlutterSharedPreferences", MODE_PRIVATE).edit().putString("flutter.solo_incoming_dir", incomingDir().absolutePath).apply()
        sweepOutgoing()
        takeSharedIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        takeSharedIntent(intent)
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode != pickRequest) return super.onActivityResult(requestCode, resultCode, data)
        val r = pickResult ?: return
        pickResult = null
        if (resultCode != RESULT_OK || data == null) { r.success(emptyList<Any>()); return }
        val uris = mutableListOf<Uri>()
        data.clipData?.let { c -> for (i in 0 until c.itemCount) uris.add(c.getItemAt(i).uri) } ?: data.data?.let { uris.add(it) }
        worker.execute {
            val out = uris.mapNotNull { stage(it) }
            runOnUiThread { r.success(out) }
        }
    }

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

            // ---- sending files to the computer ----
            "files.pick" -> {
                if (pickResult != null) { result.success(emptyList<Any>()); return }
                pickResult = result
                val i = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE); type = "*/*"; putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                }
                @Suppress("DEPRECATION") startActivityForResult(i, pickRequest)
            }
            "files.open" -> async(result) { openFile(File((call.argument<String>("path")) ?: "")) }
            "files.save" -> async(result) {
                val name = (call.argument<String>("name") ?: "file").substringAfterLast('/').substringAfterLast("\\").ifBlank { "file" }
                saveToDownloads(File(call.argument<String>("path") ?: ""), name)
            }
            "files.takeShared" -> async(result) { synchronized(shared) { val l = shared.toList(); shared.clear(); l } }
            "files.cleanup" -> async(result) {
                // only ever delete inside our own staging folder
                val root = outgoingDir().canonicalFile
                (call.arguments as? List<*>)?.forEach { p ->
                    val f = File(p.toString()).canonicalFile
                    if (f.path.startsWith(root.path + File.separator)) { f.parentFile?.takeIf { it != root }?.deleteRecursively() }
                }
                mapOf("ok" to true)
            }

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
