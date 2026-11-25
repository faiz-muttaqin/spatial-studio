package com.faizmuttaqin.spatialstudio.live

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AckWindowTest {
    @Test
    fun depthStopsFirstThenEverythingStops() {
        val w = AckWindow(softLimit = 4, hardLimit = 8)
        repeat(4) { assertTrue(w.admit(LiveFrameType.DEPTH)) }
        assertFalse(w.admit(LiveFrameType.DEPTH))
        // Pose and coverage still go out until the hard limit.
        repeat(4) { assertTrue(w.admit(LiveFrameType.POSE)) }
        assertFalse(w.admit(LiveFrameType.POSE))
        assertFalse(w.admit(LiveFrameType.PLANES))
        assertEquals(8, w.unacked)
    }

    @Test
    fun anAckReopensTheWindow() {
        val w = AckWindow(2, 4)
        repeat(2) { w.admit(LiveFrameType.DEPTH) }
        assertFalse(w.admit(LiveFrameType.DEPTH))
        w.ack(2)
        assertTrue(w.admit(LiveFrameType.DEPTH))
        assertEquals(1, w.unacked)
    }

    @Test
    fun aBusyPageThatNeverAcksCapsTheFlow() {
        val w = AckWindow()
        var sent = 0
        repeat(1000) { if (w.admit(LiveFrameType.POSE)) sent++ }
        assertEquals(8, sent)
    }

    @Test
    fun ignoresAcksForFramesNeverSentOrGoingBackwards() {
        val w = AckWindow()
        repeat(3) { w.admit(LiveFrameType.POSE) }
        w.ack(99)
        assertEquals(3, w.unacked)
        w.ack(2)
        w.ack(1)
        assertEquals(1, w.unacked)
    }

    @Test
    fun parsesOnlyWellFormedAcks() {
        assertEquals(42L, AckWindow.parse("ack:42"))
        assertEquals(0L, AckWindow.parse("ack:0"))
        assertNull(AckWindow.parse(null))
        assertNull(AckWindow.parse("ack:"))
        assertNull(AckWindow.parse("ack:-1"))
        assertNull(AckWindow.parse("ack:1x"))
        assertNull(AckWindow.parse("nack:1"))
        assertNull(AckWindow.parse("ack:" + "9".repeat(30)))
    }
}
