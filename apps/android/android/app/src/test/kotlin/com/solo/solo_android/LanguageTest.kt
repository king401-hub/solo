package com.solo.solo_android

import com.solo.solo_android.Language.Correction
import com.solo.solo_android.Language.GreetingKind
import com.solo.solo_android.Language.GreetingMatch
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// Same cases as packages/shared/src/language.test.ts
class LanguageTest {
    @Test fun plainEnglishGreetings() {
        assertEquals(GreetingMatch(GreetingKind.HELLO, ""), Language.matchGreeting("Hello"))
        assertEquals(GreetingMatch(GreetingKind.HELLO, ""), Language.matchGreeting("Hi."))
        assertEquals(GreetingMatch(GreetingKind.MORNING, ""), Language.matchGreeting("Good morning!"))
        assertEquals(GreetingMatch(GreetingKind.AFTERNOON, ""), Language.matchGreeting("good afternoon sir"))
        assertEquals(GreetingMatch(GreetingKind.EVENING, ""), Language.matchGreeting("Good evening, Solo"))
    }

    @Test fun nigerianEnglishAndPidginGreetings() {
        assertEquals(GreetingMatch(GreetingKind.HOWFAR, ""), Language.matchGreeting("How far?"))
        assertEquals(GreetingMatch(GreetingKind.HOWFAR, ""), Language.matchGreeting("how you dey"))
        assertEquals(GreetingMatch(GreetingKind.MORNING, ""), Language.matchGreeting("Good morning o"))
        assertEquals(GreetingMatch(GreetingKind.HELLO, ""), Language.matchGreeting("hello oga"))
        assertEquals(GreetingMatch(GreetingKind.HOWFAR, ""), Language.matchGreeting("wetin dey"))
    }

    @Test fun keepsWhatFollowsAsTheRequest() {
        assertEquals(GreetingMatch(GreetingKind.MORNING, "open chrome"), Language.matchGreeting("Good morning, open Chrome"))
        assertEquals(GreetingMatch(GreetingKind.HELLO, "what is the time"), Language.matchGreeting("hello what is the time"))
    }

    @Test fun ignoresGreetingsAimedAtOthersAndOrdinarySentences() {
        for (s in listOf("hi mum", "good morning everyone", "hello guys", "hey daddy", "hi baby how was school", "I said hello to him", "the hello world program", "this is high", "history of rome", "")) {
            assertNull(s, Language.matchGreeting(s))
        }
    }

    @Test fun answersAppropriately() {
        assertEquals("Good morning. How can I help?", Language.greetingReply(GreetingKind.MORNING))
        assertEquals("Good night. Rest well.", Language.greetingReply(GreetingKind.NIGHT))
        assertEquals("Good morning. How can I help?", Language.greetingReply(GreetingKind.HELLO, hour = 9))
        assertEquals("Good afternoon. How can I help?", Language.greetingReply(GreetingKind.HELLO, hour = 14))
        assertEquals("Good evening. How can I help?", Language.greetingReply(GreetingKind.HELLO, hour = 20))
        assert(Language.greetingReply(GreetingKind.HOWFAR).contains("How are you"))
    }

    @Test fun normalisesNigerianEnglishAndPidgin() {
        assertEquals("please open chrome for me", Language.normalizeNaija("Abeg open Chrome for me"))
        assertEquals("boss what is happening", Language.normalizeNaija("Oga, wetin dey happen?"))
        assertEquals("i want call my brother", Language.normalizeNaija("I wan call my brother"))
        assertEquals("no problem", Language.normalizeNaija("No wahala"))
        assertEquals("i cannot find the file", Language.normalizeNaija("I no fit find the file"))
        assertEquals("please send the message", Language.normalizeNaija("make you send the message"))
    }

    @Test fun doesNotMangleOrdinaryEnglish() {
        assertEquals("open the document and read it", Language.normalizeNaija("Open the document and read it"))
        assertEquals("sefton and abigail went home", Language.normalizeNaija("sefton and abigail went home")) // no partial-word matches
    }

    private val rules = listOf(Correction("so low", "Solo"), Correction("sorry low", "Solo"), Correction("salami", "Solomon"))

    @Test fun correctionsFixWholePhrasesCaseInsensitively() {
        assertEquals("Hey Solo open Chrome", Language.applyCorrections("Hey so low open Chrome", rules))
        assertEquals("hi Solo", Language.applyCorrections("hi SORRY LOW", rules))
        assertEquals("hey Solomon", Language.applyCorrections("hey salami", rules))
    }

    @Test fun correctionsNeverChangeInsideOtherWordsAndIgnoreEmptyRules() {
        assertEquals("a solowing example", Language.applyCorrections("a solowing example", rules))
        assertEquals("so lowest price", Language.applyCorrections("so lowest price", rules))
        assertEquals("keep this", Language.applyCorrections("keep this", listOf(Correction("", "x"), Correction("y", ""))))
    }

    @Test fun correctionsCopeWithRegexCharacters() {
        assertEquals("price is five dollars", Language.applyCorrections("price is \$5 (ok)", listOf(Correction("\$5 (ok)", "five dollars"))))
    }
}
