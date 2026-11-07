package com.solo.solo_android

import java.text.Normalizer

/**
 * Wake-phrase matching. Mirrors packages/shared/src/voice.ts `matchWake` (keep the cases in WakeMatcherTest identical
 * to voice.test.ts). A wake phrase only counts at the START of an utterance, so a sentence that merely mentions Solo
 * ("I told Solo yesterday") never wakes it, and a bare "Hi" never does.
 */
object WakeMatcher {
    data class Match(val matched: Boolean, val rest: String)

    private val SOLO = listOf("solo", "sollo", "so low", "so lo", "soloh")
    private val SOLOMON = listOf("solomon", "salomon", "soloman", "solomun")
    private val HEY = listOf("hey", "hay", "hi", "hei", "okay", "ok")
    private val DIACRITICS = Regex("[\\u0300-\\u036f]")
    private val NON_WORD = Regex("[^a-z0-9\\s]")
    private val SPACES = Regex("\\s+")

    fun norm(s: String): String =
        Normalizer.normalize(s.lowercase(), Normalizer.Form.NFKD)
            .replace(DIACRITICS, "")
            .replace(NON_WORD, " ")
            .replace(SPACES, " ")
            .trim()

    fun match(transcript: String, quick: Boolean = true): Match {
        val t = norm(transcript)
        if (t.isEmpty()) return Match(false, "")
        val names = SOLO + SOLOMON
        for (h in HEY) for (n in names) {
            val p = "$h $n"
            if (t == p || t.startsWith("$p ")) return Match(true, t.removePrefix(p).trim())
        }
        if (quick) for (n in names) {
            if (t == n || t.startsWith("$n ")) return Match(true, t.removePrefix(n).trim())
        }
        return Match(false, "")
    }
}
