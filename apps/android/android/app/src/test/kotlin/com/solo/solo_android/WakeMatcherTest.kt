package com.solo.solo_android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// Same cases as packages/shared/src/voice.test.ts
class WakeMatcherTest {
    @Test fun matchesHeyAndHiAndReturnsRequest() {
        assertEquals(WakeMatcher.Match(true, "open chrome"), WakeMatcher.match("Hey Solo, open Chrome"))
        assertEquals(WakeMatcher.Match(true, "good morning"), WakeMatcher.match("Hi Solo, good morning"))
        assertEquals(WakeMatcher.Match(true, ""), WakeMatcher.match("Hey Solo"))
        assertEquals(WakeMatcher.Match(true, ""), WakeMatcher.match("hi solomon"))
    }

    @Test fun toleratesCommonMishearings() {
        assertTrue(WakeMatcher.match("hay solo let's continue").matched)
        assertTrue(WakeMatcher.match("hey so low open vs code").matched)
        assertTrue(WakeMatcher.match("hi salomon").matched)
    }

    @Test fun bareSoloAndSolomonOnlyWithQuickActivation() {
        assertFalse(WakeMatcher.match("solo open chrome", quick = false).matched)
        assertEquals(WakeMatcher.Match(true, "open chrome"), WakeMatcher.match("solo open chrome", quick = true))
        assertEquals(WakeMatcher.Match(true, "what time is it"), WakeMatcher.match("Solomon, what time is it", quick = true))
        assertEquals(WakeMatcher.Match(true, ""), WakeMatcher.match("Solo.", quick = true))
    }

    @Test fun doesNotWakeOnMentionsOrBareHi() {
        assertFalse(WakeMatcher.match("I told Solo yesterday").matched)
        assertFalse(WakeMatcher.match("play some solo guitar").matched)
        assertFalse(WakeMatcher.match("I think solo is great").matched)
        assertFalse(WakeMatcher.match("Hi").matched)
        assertFalse(WakeMatcher.match("hi everyone").matched)
        assertFalse(WakeMatcher.match("").matched)
    }
}
