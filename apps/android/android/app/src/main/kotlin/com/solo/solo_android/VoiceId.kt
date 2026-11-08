package com.solo.solo_android

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Shared access (service and UI bridge) to the phone's speaker model, the owner's voice print and the voice settings.
 * Everything is local to this phone: nothing here is synced or sent anywhere.
 */
object VoiceId {
    const val MODEL = "Xenova/wavlm-base-plus-sv"
    private const val PREFS = "solo_wake"
    private const val MIN_MODEL_BYTES = 90_000_000L

    @Volatile private var embedder: SpeakerEmbedder? = null
    @Volatile private var store: VoiceIdStore? = null

    /** The model ships inside the APK; ONNX Runtime needs a real file, so copy it out once. */
    private fun modelFile(ctx: Context): File {
        val f = File(ctx.filesDir, "wavlm-sv/model_quantized.onnx")
        if (f.exists() && f.length() >= MIN_MODEL_BYTES) return f
        f.parentFile?.mkdirs()
        val tmp = File(f.path + ".tmp")
        ctx.assets.open("wavlm-sv/model_quantized.onnx").use { i -> tmp.outputStream().use { o -> i.copyTo(o, 1 shl 20) } }
        if (!tmp.renameTo(f)) { f.delete(); tmp.renameTo(f) }
        return f
    }

    fun embedder(ctx: Context): SpeakerEmbedder = synchronized(this) {
        embedder ?: SpeakerEmbedder({ modelFile(ctx.applicationContext) }).also { embedder = it }
    }

    fun store(ctx: Context): VoiceIdStore = synchronized(this) {
        store ?: VoiceIdStore(File(ctx.applicationContext.filesDir, "voiceprint.bin"), embedder(ctx), MODEL, KeystoreCrypt()).also { store = it }
    }

    /** Loads the model now (copying it on first use) so the first verification is not slow. */
    fun warmup(ctx: Context): String? = try { embedder(ctx).ioNames(); null } catch (e: Throwable) { e.message ?: e.toString() }

    // ---- settings (this phone only) ----

    data class Config(val onlyMyVoice: Boolean, val greetingsWake: Boolean, val allowInterrupt: Boolean, val strictness: Double)

    fun config(ctx: Context): Config {
        val p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        return Config(
            p.getBoolean("onlyMyVoice", true), p.getBoolean("greetingsWake", true), p.getBoolean("allowInterrupt", true),
            p.getFloat("strictness", VoicePrintMath.DEFAULT_STRICTNESS.toFloat()).toDouble().coerceIn(0.0, 1.0),
        )
    }

    fun setConfig(ctx: Context, m: Map<*, *>) {
        val e = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
        (m["onlyMyVoice"] as? Boolean)?.let { e.putBoolean("onlyMyVoice", it) }
        (m["greetingsWake"] as? Boolean)?.let { e.putBoolean("greetingsWake", it) }
        (m["allowInterrupt"] as? Boolean)?.let { e.putBoolean("allowInterrupt", it) }
        (m["strictness"] as? Number)?.let { e.putFloat("strictness", it.toFloat().coerceIn(0f, 1f)) }
        e.apply()
    }

    fun corrections(ctx: Context): List<Language.Correction> = try {
        val a = JSONArray(ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("corrections", "[]"))
        (0 until a.length()).map { Language.Correction(a.getJSONObject(it).getString("heard"), a.getJSONObject(it).getString("meant")) }
    } catch (_: Exception) { emptyList() }

    fun setCorrections(ctx: Context, list: List<Language.Correction>) {
        val a = JSONArray()
        list.filter { it.heard.isNotBlank() && it.meant.isNotBlank() }.takeLast(200).forEach { a.put(JSONObject().put("heard", it.heard.trim().lowercase()).put("meant", it.meant.trim())) }
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("corrections", a.toString()).apply()
    }
}
