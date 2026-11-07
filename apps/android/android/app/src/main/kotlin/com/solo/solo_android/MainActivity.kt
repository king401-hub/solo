package com.solo.solo_android

import android.Manifest
import android.content.pm.PackageManager
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel

/** Bridge for the on-phone wake-word listener. The listener itself lives in [WakeService]. */
class MainActivity : FlutterActivity() {
    private val micRequest = 7101
    private var pending: MethodChannel.Result? = null

    private fun micGranted() =
        ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "solo/wake").setMethodCallHandler { call, result -> handle(call, result) }
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
