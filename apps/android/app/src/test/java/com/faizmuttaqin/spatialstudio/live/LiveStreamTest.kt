package com.faizmuttaqin.spatialstudio.live

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LiveStreamTest {
    private class Recording(var accept: Boolean = true) : LiveTransport {
        override val name = "test"
        val frames = ArrayList<ByteArray>()
        var closed = 0
        override fun send(frame: ByteArray): Boolean {
            if (!accept) return false
            frames.add(frame)
            return true
        }
        override fun close() {
            closed++
        }
    }

    private val ms = 1_000_000L

    @Test
    fun nothingIsWantedWithoutATransport() {
        val stream = LiveStream()
        assertFalse(stream.wants(LiveFrameType.DEPTH, 0))
        assertFalse(stream.submit(LiveFrameType.DEPTH, 0, ByteArray(10)))
    }

    @Test
    fun depthIsLimitedToFiveHertz() {
        val stream = LiveStream()
        stream.attach(Recording())
        var sent = 0
        // 60 Hz of frames for 2 s.
        for (i in 0 until 120) {
            val t = i * 16 * ms
            if (stream.wants(LiveFrameType.DEPTH, t) && stream.submit(LiveFrameType.DEPTH, t, ByteArray(43_000))) sent++
        }
        assertTrue("sent $sent depth frames in about 2 s", sent in 9..11)
    }

    @Test
    fun byteBudgetCapsASustainedOverload() {
        val rates = LiveRates(intervalsNs = emptyMap(), bytesPerSecond = 100_000, burstBytes = 100_000)
        var accepted = 0L
        for (i in 0 until 100) if (rates.spend(LiveFrameType.DEPTH, 1_000_000_000L + i * 10 * ms, 10_000)) accepted += 10_000
        // A 100 KB burst plus about 100 KB per second of the 1 s tested.
        assertTrue("accepted $accepted", accepted in 150_000..210_000)
    }

    @Test
    fun aRefusedFrameCountsAsDroppedAndDoesNotStallTheStream() {
        val stream = LiveStream()
        val transport = Recording(accept = false)
        stream.attach(transport)
        assertFalse(stream.submit(LiveFrameType.POSE, 0, ByteArray(100)))
        assertEquals(1, stream.framesDropped)
        transport.accept = true
        assertTrue(stream.submit(LiveFrameType.POSE, 1_000 * ms, ByteArray(100)))
        assertEquals(1, stream.framesSent)
    }

    @Test
    fun anOversizedFrameIsDropped() {
        val stream = LiveStream()
        val transport = Recording()
        stream.attach(transport)
        assertFalse(stream.submit(LiveFrameType.DEPTH, 0, ByteArray(LiveFrames.MAX_FRAME_BYTES + 1)))
        assertTrue(transport.frames.isEmpty())
    }

    @Test
    fun detachClosesTheTransportOnceAndStopsTheFlow() {
        val stream = LiveStream()
        val transport = Recording()
        stream.attach(transport)
        stream.detach()
        stream.detach()
        assertEquals(1, transport.closed)
        assertFalse(stream.isOpen)
        assertFalse(stream.wants(LiveFrameType.POSE, 5_000 * ms))
    }

    @Test
    fun attachingANewTransportClosesTheOldOne() {
        val stream = LiveStream()
        val first = Recording()
        val second = Recording()
        stream.attach(first)
        stream.attach(second)
        assertEquals(1, first.closed)
        assertEquals(0, second.closed)
    }
}
