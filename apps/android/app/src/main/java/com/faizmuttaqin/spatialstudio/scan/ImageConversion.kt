package com.faizmuttaqin.spatialstudio.scan

import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.max
import kotlin.math.roundToInt

/** Pinhole intrinsics in pixels of the image they describe. */
data class Intrinsics(val fx: Double, val fy: Double, val cx: Double, val cy: Double) {
    fun scaled(sx: Double, sy: Double) = Intrinsics(fx * sx, fy * sy, cx * sx, cy * sy)
    val isValid: Boolean get() = fx > 0 && fy > 0 && cx >= 0 && cy >= 0 && listOf(fx, fy, cx, cy).all { it.isFinite() }
}

/** One plane of an `android.media.Image`, without the Android type. */
class PlaneData(val buffer: ByteBuffer, val rowStride: Int, val pixelStride: Int)

object ImageConversion {
    /** Size that keeps the aspect ratio with the long edge at most [maxLongEdge]. */
    fun fitLongEdge(width: Int, height: Int, maxLongEdge: Int): Pair<Int, Int> {
        val longEdge = max(width, height)
        if (longEdge <= maxLongEdge) return width to height
        val scale = maxLongEdge.toDouble() / longEdge
        return max(1, (width * scale).roundToInt()) to max(1, (height * scale).roundToInt())
    }

    /** Largest power-of-two decode reduction that still yields at least the target size. */
    fun sampleSizeFor(width: Int, height: Int, targetWidth: Int, targetHeight: Int): Int {
        var sample = 1
        while (width / (sample * 2) >= targetWidth && height / (sample * 2) >= targetHeight) sample *= 2
        return sample
    }

    /** Converts YUV_420_888 planes to NV21 (Y plane, then interleaved V/U) for `YuvImage`. */
    fun yuv420ToNv21(width: Int, height: Int, y: PlaneData, u: PlaneData, v: PlaneData): ByteArray {
        val out = ByteArray(width * height + 2 * ((width + 1) / 2) * ((height + 1) / 2))
        var o = 0
        val yBuf = y.buffer.duplicate()
        for (row in 0 until height) {
            val rowStart = row * y.rowStride
            if (y.pixelStride == 1) {
                yBuf.position(rowStart)
                yBuf.get(out, o, width)
                o += width
            } else {
                for (col in 0 until width) out[o++] = yBuf.get(rowStart + col * y.pixelStride)
            }
        }
        val chromaWidth = (width + 1) / 2
        val chromaHeight = (height + 1) / 2
        val uBuf = u.buffer.duplicate()
        val vBuf = v.buffer.duplicate()
        for (row in 0 until chromaHeight) {
            for (col in 0 until chromaWidth) {
                out[o++] = vBuf.get(row * v.rowStride + col * v.pixelStride)
                out[o++] = uBuf.get(row * u.rowStride + col * u.pixelStride)
            }
        }
        return out
    }

    /**
     * Copies a 16-bit single-channel plane (DEPTH16 from ARCore, native byte order)
     * into tightly packed little-endian row-major bytes.
     */
    fun packUint16LittleEndian(width: Int, height: Int, plane: PlaneData): ByteArray {
        val src = plane.buffer.duplicate().order(ByteOrder.nativeOrder())
        val out = ByteBuffer.allocate(width * height * 2).order(ByteOrder.LITTLE_ENDIAN)
        for (row in 0 until height) {
            for (col in 0 until width) {
                out.putShort(src.getShort(row * plane.rowStride + col * plane.pixelStride))
            }
        }
        return out.array()
    }

    /** Copies an 8-bit single-channel plane into tightly packed row-major bytes. */
    fun packUint8(width: Int, height: Int, plane: PlaneData): ByteArray {
        val src = plane.buffer.duplicate()
        val out = ByteArray(width * height)
        var o = 0
        for (row in 0 until height) {
            for (col in 0 until width) out[o++] = src.get(row * plane.rowStride + col * plane.pixelStride)
        }
        return out
    }
}
