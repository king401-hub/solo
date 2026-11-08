package com.solo.solo_android

import java.text.Normalizer
import java.util.Calendar

/**
 * Greetings, Nigerian English / Pidgin normalisation and user-taught corrections. Mirrors packages/shared/src/language.ts
 * (keep the cases in LanguageTest identical to language.test.ts).
 *
 * Honest scope: small rule-based helpers. They do not understand Pidgin grammar in general; real interpretation of
 * meaning is left to the conversational model (Phase 4).
 */
object Language {
    enum class GreetingKind { MORNING, AFTERNOON, EVENING, NIGHT, HELLO, HOWFAR }
    data class GreetingMatch(val kind: GreetingKind, val rest: String)
    data class Correction(val heard: String, val meant: String)

    private val DIACRITICS = Regex("[\\u0300-\\u036f]")
    private val NOT_WORD = Regex("[^a-z0-9\\s']")
    private val SPACES = Regex("\\s+")

    fun norm(s: String): String =
        Normalizer.normalize(s.lowercase(), Normalizer.Form.NFKD).replace(DIACRITICS, "").replace(NOT_WORD, " ").replace("'", "").replace(SPACES, " ").trim()

    private val GREETINGS: List<Pair<Regex, GreetingKind>> = listOf(
        Regex("^good morning\\b") to GreetingKind.MORNING, Regex("^good afternoon\\b") to GreetingKind.AFTERNOON,
        Regex("^good evening\\b") to GreetingKind.EVENING, Regex("^good night\\b") to GreetingKind.NIGHT,
        Regex("^(hello|hi|hey|hiya|howdy)\\b") to GreetingKind.HELLO, Regex("^(morning|afternoon|evening)\\b") to GreetingKind.HELLO,
        Regex("^how far\\b") to GreetingKind.HOWFAR, Regex("^how you dey\\b") to GreetingKind.HOWFAR, Regex("^how body\\b") to GreetingKind.HOWFAR,
        Regex("^how una dey\\b") to GreetingKind.HOWFAR, Regex("^wetin dey\\b") to GreetingKind.HOWFAR, Regex("^how now\\b") to GreetingKind.HOWFAR,
    )
    private val VOCATIVES = setOf("sir", "ma", "madam", "boss", "oga", "bro", "there", "o", "na", "please", "solo", "solomon", "again", "friend", "my", "man", "dear")
    private val OTHERS = setOf("mum", "mom", "mummy", "mommy", "dad", "daddy", "baby", "honey", "darling", "sweetheart", "everyone", "everybody", "guys", "folks", "team", "class", "uncle", "aunty", "auntie", "sister", "brother", "pastor", "doctor", "teacher", "madam's", "all", "boys", "girls", "children", "kids")

    /** A greeting at the START of an utterance; greetings aimed at someone else ("hi mum") are not taken. */
    fun matchGreeting(transcript: String): GreetingMatch? {
        val t = norm(transcript)
        if (t.isEmpty()) return null
        for ((re, kind) in GREETINGS) {
            val m = re.find(t) ?: continue
            val words = t.substring(m.value.length).trim().split(" ").filter { it.isNotEmpty() }
            var i = 0
            while (i < words.size && words[i] in VOCATIVES && i < 3) i++
            val rest = words.drop(i)
            if (rest.isNotEmpty() && rest.size <= 2 && rest.any { it in OTHERS }) return null
            if (rest.isEmpty() && words.isNotEmpty() && words.any { it in OTHERS }) return null
            if (i == 0 && words.isNotEmpty() && words[0] in OTHERS) return null
            return GreetingMatch(kind, rest.joinToString(" "))
        }
        return null
    }

    fun greetingReply(kind: GreetingKind, hour: Int = Calendar.getInstance().get(Calendar.HOUR_OF_DAY)): String {
        val part = if (hour < 12) "morning" else if (hour < 17) "afternoon" else "evening"
        return when (kind) {
            GreetingKind.MORNING -> "Good morning. How can I help?"
            GreetingKind.AFTERNOON -> "Good afternoon. How can I help?"
            GreetingKind.EVENING -> "Good evening. How can I help?"
            GreetingKind.NIGHT -> "Good night. Rest well."
            GreetingKind.HOWFAR -> "I'm doing well, thank you. How are you, and how can I help?"
            GreetingKind.HELLO -> "Good $part. How can I help?"
        }
    }

    /** Longest phrases first. Conservative: ambiguous words ("na", "dey" alone) are left alone. */
    private val LEXICON = listOf(
        "wetin dey happen" to "what is happening", "how you dey" to "how are you", "how una dey" to "how are you", "how far" to "how are you", "how body" to "how are you",
        "no wahala" to "no problem", "i dey fine" to "i am fine", "i dey come" to "i am coming", "i dey go" to "i am going", "abeg make you" to "please",
        "make you" to "please", "make i" to "let me", "i wan" to "i want", "i no wan" to "i do not want", "i no fit" to "i cannot", "you fit" to "can you",
        "i no know" to "i do not know", "no be" to "is not", "wetin" to "what", "abeg" to "please", "oga" to "boss", "wahala" to "trouble",
        "comot" to "leave", "sabi" to "know", "pikin" to "child", "chop" to "eat", "abi" to "right", "oya" to "come on", "jare" to "please",
        "sef" to "even", "wey" to "that", "dey" to "is",
    )

    /** Rewrites common Nigerian English and Pidgin expressions to plain English for intent routing. Not for display. */
    fun normalizeNaija(text: String): String {
        var t = " ${norm(text)} "
        for ((from, to) in LEXICON) t = t.replace(" $from ", " $to ").replace(" $from ", " $to ")
        return t.replace(SPACES, " ").trim()
    }

    /** Applies the corrections the user taught Solo ("sorry low" really means "Solo"). Whole phrases, case-insensitive. */
    fun applyCorrections(text: String, rules: List<Correction>): String {
        var out = text
        for (r in rules.filter { it.heard.isNotBlank() && it.meant.isNotBlank() }.sortedByDescending { it.heard.length }) {
            val body = r.heard.trim().split(Regex("\\s+")).joinToString("\\s+") { Regex.escape(it) }
            val re = Regex("(^|[^\\p{L}\\p{N}])$body(?=$|[^\\p{L}\\p{N}])", RegexOption.IGNORE_CASE)
            out = re.replace(out) { m -> m.groupValues[1] + r.meant.trim() }
        }
        return out
    }
}
