package com.faizmuttaqin.spatialstudio.live

import java.nio.ByteBuffer
import java.nio.ByteOrder
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class LiveFramesTest {
    private val pose = FloatArray(16) { if (it % 5 == 0) 1f else 0f }
    private val intrinsics = floatArrayOf(120f, 121f, 80f, 45f)

    @Test
    fun depthFrameHasTheDocumentedSize() {
        val w = 160
        val h = 90
        val frame = LiveFrames.depth(7, 123_456_789L, w, h, intrinsics, pose, ByteArray(w * h * 2), ByteArray(w * h))
        // Header 24 + 4 + 16 + 64 + 28,800 + 14,400.
        assertEquals(24 + 84 + 43_200, frame.size)
        val header = LiveFrames.parseHeader(frame)!!
        assertEquals(LiveFrameType.DEPTH, header.type)
        assertEquals(7L, header.seq)
        assertEquals(123_456_789L, header.timestampNs)
        assertEquals(LiveFrames.FLAG_HAS_CONFIDENCE, header.flags)
        assertEquals(frame.size - LiveFrames.HEADER_BYTES, header.payloadLength)
    }

    @Test
    fun depthPayloadIsLittleEndianAndOrdered() {
        val depth = byteArrayOf(0x34, 0x12, 0x78, 0x56)
        val frame = LiveFrames.depth(0, 0, 2, 1, intrinsics, pose, depth, null)
        val b = ByteBuffer.wrap(frame).order(ByteOrder.LITTLE_ENDIAN)
        b.position(LiveFrames.HEADER_BYTES)
        assertEquals(2, b.short.toInt())
        assertEquals(1, b.short.toInt())
        assertEquals(120f, b.float, 0f)
        b.position(LiveFrames.HEADER_BYTES + LiveFrames.DEPTH_FIXED_BYTES)
        assertEquals(0x1234, b.short.toInt())
        assertEquals(0x5678, b.short.toInt())
        assertEquals(0, LiveFrames.parseHeader(frame)!!.flags)
    }

    @Test
    fun depthBeyondTheBoundsIsRefused() {
        assertRefused { LiveFrames.depth(0, 0, 201, 200, intrinsics, pose, ByteArray(201 * 200 * 2), null) }
        assertRefused { LiveFrames.depth(0, 0, 0, 10, intrinsics, pose, ByteArray(0), null) }
        assertRefused { LiveFrames.depth(0, 0, 4, 4, intrinsics, pose, ByteArray(10), null) }
        assertRefused { LiveFrames.depth(0, 0, 4, 4, intrinsics, pose, ByteArray(32), ByteArray(3)) }
        assertRefused { LiveFrames.depth(0, 0, 4, 4, FloatArray(3), pose, ByteArray(32), null) }
    }

    @Test
    fun largestAllowedDepthFitsThePayloadBound() {
        val side = 200
        val frame = LiveFrames.depth(0, 0, side, side, intrinsics, pose, ByteArray(side * side * 2), ByteArray(side * side))
        assertTrue(frame.size <= LiveFrames.MAX_FRAME_BYTES)
        assertNotNull(LiveFrames.parseHeader(frame))
    }

    @Test
    fun poseFrame() {
        val frame = LiveFrames.pose(1, 5, pose, LiveFrames.TrackingCode.PAUSED)
        assertEquals(LiveFrames.HEADER_BYTES + LiveFrames.POSE_BYTES, frame.size)
        assertEquals(LiveFrameType.POSE, LiveFrames.parseHeader(frame)!!.type)
        assertEquals(LiveFrames.TrackingCode.PAUSED.wire, frame[LiveFrames.HEADER_BYTES + 64].toInt())
    }

    @Test
    fun coverageIsCappedAndKeepsCellOrder() {
        val cells = LongArray(LiveFrames.MAX_COVERAGE_CELLS + 500) { (it.toLong() shl 32) xor (-it.toLong() and 0xffffffffL) }
        val frame = LiveFrames.coverage(2, 0, 0.25f, Float.NaN, -1, cells, cells.size)
        val b = ByteBuffer.wrap(frame).order(ByteOrder.LITTLE_ENDIAN)
        b.position(LiveFrames.HEADER_BYTES + 4)
        assertTrue(b.float.isNaN())
        assertEquals(-1, b.short.toInt())
        assertEquals(LiveFrames.MAX_COVERAGE_CELLS, b.short.toInt() and 0xFFFF)
        assertEquals(0, b.int)
        assertEquals(0, b.int)
        assertEquals(1, b.int)
        assertEquals(-1, b.int)
        assertTrue(frame.size <= LiveFrames.MAX_FRAME_BYTES)
        assertNotNull(LiveFrames.parseHeader(frame))
    }

    @Test
    fun emptyCoverageIsValid() {
        val frame = LiveFrames.coverage(0, 0, 0.25f, 0f, 0, LongArray(0), 0)
        assertEquals(LiveFrames.HEADER_BYTES + 12, frame.size)
        assertNotNull(LiveFrames.parseHeader(frame))
    }

    @Test
    fun planesAreCapped() {
        val planes = List(LiveFrames.MAX_PLANES + 10) { LiveFrames.PlaneInput(LiveFrames.PlaneOrientation.HORIZONTAL_UP, pose, 1f, 2f) }
        val frame = LiveFrames.planes(3, 0, planes)
        assertEquals(LiveFrames.HEADER_BYTES + 4 + LiveFrames.MAX_PLANES * LiveFrames.PLANE_BYTES, frame.size)
        assertEquals(LiveFrames.MAX_PLANES, frame[LiveFrames.HEADER_BYTES].toInt())
        assertEquals(LiveFrames.PlaneOrientation.VERTICAL, LiveFrames.PlaneOrientation.of("vertical"))
        assertEquals(LiveFrames.PlaneOrientation.OTHER, LiveFrames.PlaneOrientation.of("surprise"))
    }

    @Test
    fun parseHeaderRejectsMalformedFrames() {
        val good = LiveFrames.pose(1, 2, pose, LiveFrames.TrackingCode.TRACKING)
        assertNull(LiveFrames.parseHeader(good.copyOf(10)))
        assertNull(LiveFrames.parseHeader(good.copyOf(good.size - 1)))
        assertNull(LiveFrames.parseHeader(good + byteArrayOf(0)))
        assertNull(LiveFrames.parseHeader(good.clone().also { it[0] = 'X'.code.toByte() }))
        assertNull(LiveFrames.parseHeader(good.clone().also { it[4] = 99 }))
        assertNull(LiveFrames.parseHeader(good.clone().also { it[6] = 1 }))
        assertNull(LiveFrames.parseHeader(ByteArray(LiveFrames.MAX_FRAME_BYTES + 1)))
    }

    @Test
    fun sequenceNumbersWrapAsUnsigned() {
        val frame = LiveFrames.pose(0xFFFFFFFFL, 0, pose, LiveFrames.TrackingCode.NONE)
        assertEquals(0xFFFFFFFFL, LiveFrames.parseHeader(frame)!!.seq)
    }

    private fun assertRefused(block: () -> Unit) {
        try {
            block()
            fail("expected the frame to be refused")
        } catch (e: IllegalArgumentException) {
            assertFalse(e.message.isNullOrEmpty())
        }
    }
}
