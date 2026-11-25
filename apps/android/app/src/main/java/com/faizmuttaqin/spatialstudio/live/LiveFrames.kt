package com.faizmuttaqin.spatialstudio.live

import java.nio.ByteBuffer
import java.nio.ByteOrder

/** Frame kinds of the live preview stream. The values are part of the wire format. */
enum class LiveFrameType(val wire: Int) {
    DEPTH(1),
    POSE(2),
    COVERAGE(3),
    PLANES(4),
    ;

    companion object {
        fun of(wire: Int): LiveFrameType? = entries.firstOrNull { it.wire == wire }
    }
}

/**
 * Binary framing of the live preview stream (SENSING_RESEARCH.md, P2N.3). One frame is one
 * transport message, little endian, with a 24 byte header:
 *
 * `magic "SSL1"` (4), `type` u8, `flags` u8, `reserved` u16 (zero), `seq` u32, `timestampNs` i64,
 * `payloadLength` u32, then the payload. The stream is a preview only; the recorded bundle stays the
 * source of truth. No Android types, so it is unit-testable on the JVM.
 */
object LiveFrames {
    const val HEADER_BYTES = 24
    const val MAGIC_0 = 'S'.code.toByte()
    const val MAGIC_1 = 'S'.code.toByte()
    const val MAGIC_2 = 'L'.code.toByte()
    const val MAGIC_3 = '1'.code.toByte()

    /** Hard bounds, enforced when encoding and when decoding. */
    const val MAX_PAYLOAD_BYTES = 128 * 1024
    const val MAX_FRAME_BYTES = HEADER_BYTES + MAX_PAYLOAD_BYTES
    const val MAX_DEPTH_PIXELS = 40_000
    const val MAX_COVERAGE_CELLS = 4_096
    const val MAX_PLANES = 32

    const val FLAG_HAS_CONFIDENCE = 1

    const val DEPTH_FIXED_BYTES = 4 + 16 + 64
    const val POSE_BYTES = 64 + 4
    const val PLANE_BYTES = 64 + 8 + 4
    const val NO_FLOOR = Float.NaN

    enum class TrackingCode(val wire: Int) { NONE(0), TRACKING(1), PAUSED(2), STOPPED(3) }

    enum class PlaneOrientation(val wire: Int) {
        OTHER(0),
        HORIZONTAL_UP(1),
        HORIZONTAL_DOWN(2),
        VERTICAL(3),
        ;

        companion object {
            fun of(name: String): PlaneOrientation = when (name) {
                "horizontal-up" -> HORIZONTAL_UP
                "horizontal-down" -> HORIZONTAL_DOWN
                "vertical" -> VERTICAL
                else -> OTHER
            }
        }
    }

    class Header(val type: LiveFrameType, val flags: Int, val seq: Long, val timestampNs: Long, val payloadLength: Int)

    private fun buffer(type: LiveFrameType, flags: Int, seq: Long, timestampNs: Long, payloadLength: Int): ByteBuffer {
        require(payloadLength in 0..MAX_PAYLOAD_BYTES) { "payload of $payloadLength bytes exceeds $MAX_PAYLOAD_BYTES" }
        val b = ByteBuffer.allocate(HEADER_BYTES + payloadLength).order(ByteOrder.LITTLE_ENDIAN)
        b.put(MAGIC_0).put(MAGIC_1).put(MAGIC_2).put(MAGIC_3)
        b.put(type.wire.toByte()).put(flags.toByte()).putShort(0)
        b.putInt(seq.toInt()).putLong(timestampNs).putInt(payloadLength)
        return b
    }

    /**
     * Depth plus optional confidence. `payload`: width u16, height u16, fx fy cx cy f32 (depth pixels),
     * camera-to-world pose f32 x16 (column-major), depth u16 little endian x w*h (millimetres, 0 = none), then confidence
     * u8 x w*h when [FLAG_HAS_CONFIDENCE] is set. 160 x 90 with confidence is 43,284 bytes plus the header.
     */
    fun depth(
        seq: Long,
        timestampNs: Long,
        width: Int,
        height: Int,
        intrinsics: FloatArray,
        pose: FloatArray,
        depthLe: ByteArray,
        confidence: ByteArray?,
    ): ByteArray {
        require(width in 1..0xFFFF && height in 1..0xFFFF && width * height <= MAX_DEPTH_PIXELS) { "depth size out of bounds" }
        val pixels = width * height
        require(depthLe.size == pixels * 2) { "depth has ${depthLe.size} bytes, expected ${pixels * 2}" }
        require(confidence == null || confidence.size == pixels) { "confidence size mismatch" }
        require(intrinsics.size == 4 && pose.size == 16) { "intrinsics need 4 and pose 16 floats" }
        val payload = 4 + 16 + 64 + pixels * 2 + if (confidence != null) pixels else 0
        val b = buffer(LiveFrameType.DEPTH, if (confidence != null) FLAG_HAS_CONFIDENCE else 0, seq, timestampNs, payload)
        b.putShort(width.toShort()).putShort(height.toShort())
        intrinsics.forEach(b::putFloat)
        pose.forEach(b::putFloat)
        b.put(depthLe)
        confidence?.let(b::put)
        return b.array()
    }

    /** Camera pose: f32 x16 column-major camera-to-world, tracking u8, three zero bytes. */
    fun pose(seq: Long, timestampNs: Long, pose: FloatArray, tracking: TrackingCode): ByteArray {
        require(pose.size == 16) { "pose needs 16 floats" }
        val b = buffer(LiveFrameType.POSE, 0, seq, timestampNs, POSE_BYTES)
        pose.forEach(b::putFloat)
        b.put(tracking.wire.toByte()).put(0).putShort(0)
        return b.array()
    }

    /**
     * Covered floor cells: cell size f32, floor y f32 (NaN when unknown), covered percent i16 (-1 unknown),
     * cell count u16, then count x (cx i32, cz i32) in cell units. Cells past [MAX_COVERAGE_CELLS] are dropped.
     */
    fun coverage(seq: Long, timestampNs: Long, cellMetres: Float, floorY: Float, percent: Int, cells: LongArray, cellCount: Int): ByteArray {
        val n = minOf(cellCount, cells.size, MAX_COVERAGE_CELLS)
        val b = buffer(LiveFrameType.COVERAGE, 0, seq, timestampNs, 4 + 4 + 2 + 2 + n * 8)
        b.putFloat(cellMetres).putFloat(floorY).putShort(percent.toShort()).putShort(n.toShort())
        for (i in 0 until n) b.putInt((cells[i] shr 32).toInt()).putInt(cells[i].toInt())
        return b.array()
    }

    class PlaneInput(val orientation: PlaneOrientation, val centerPose: FloatArray, val extentX: Float, val extentZ: Float)

    /** Planes: count u8, three zero bytes, then count x (pose f32 x16, extentX f32, extentZ f32, orientation u8, three zero bytes). */
    fun planes(seq: Long, timestampNs: Long, planes: List<PlaneInput>): ByteArray {
        val n = minOf(planes.size, MAX_PLANES)
        val b = buffer(LiveFrameType.PLANES, 0, seq, timestampNs, 4 + n * PLANE_BYTES)
        b.put(n.toByte()).put(0).putShort(0)
        for (i in 0 until n) {
            val p = planes[i]
            require(p.centerPose.size == 16) { "plane pose needs 16 floats" }
            p.centerPose.forEach(b::putFloat)
            b.putFloat(p.extentX).putFloat(p.extentZ).put(p.orientation.wire.toByte()).put(0).putShort(0)
        }
        return b.array()
    }

    /** Validates a frame the way the page does; null when malformed or over a bound. */
    fun parseHeader(frame: ByteArray): Header? {
        if (frame.size < HEADER_BYTES || frame.size > MAX_FRAME_BYTES) return null
        val b = ByteBuffer.wrap(frame).order(ByteOrder.LITTLE_ENDIAN)
        if (b.get() != MAGIC_0 || b.get() != MAGIC_1 || b.get() != MAGIC_2 || b.get() != MAGIC_3) return null
        val type = LiveFrameType.of(b.get().toInt() and 0xFF) ?: return null
        val flags = b.get().toInt() and 0xFF
        if (b.short.toInt() != 0) return null
        val seq = b.int.toLong() and 0xFFFFFFFFL
        val timestamp = b.long
        val length = b.int
        if (length < 0 || length != frame.size - HEADER_BYTES) return null
        return Header(type, flags, seq, timestamp, length)
    }
}
