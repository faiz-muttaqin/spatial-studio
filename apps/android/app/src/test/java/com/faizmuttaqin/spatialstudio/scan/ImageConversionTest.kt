package com.faizmuttaqin.spatialstudio.scan

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder

class ImageConversionTest {

    @Test
    fun fitsTheLongEdge() {
        assertEquals(1920 to 1080, ImageConversion.fitLongEdge(1920, 1080, 1920))
        assertEquals(1920 to 1440, ImageConversion.fitLongEdge(2560, 1920, 1920))
        assertEquals(1080 to 1920, ImageConversion.fitLongEdge(1440, 2560, 1920))
        assertEquals(640 to 480, ImageConversion.fitLongEdge(640, 480, 1920))
    }

    @Test
    fun decodesAtTheLargestPowerOfTwoAboveTheTarget() {
        assertEquals(1, ImageConversion.sampleSizeFor(2560, 1440, 1920, 1080))
        assertEquals(2, ImageConversion.sampleSizeFor(4000, 3000, 1920, 1440))
        assertEquals(4, ImageConversion.sampleSizeFor(8000, 6000, 1920, 1440))
    }

    @Test
    fun scalesIntrinsicsWithTheImage() {
        val k = Intrinsics(1000.0, 1000.0, 960.0, 540.0).scaled(0.5, 0.5)
        assertEquals(Intrinsics(500.0, 500.0, 480.0, 270.0), k)
    }

    @Test
    fun convertsPaddedYuv420ToNv21() {
        // 4x2 image, Y row stride 6 (padded), chroma 2x1 interleaved with pixel stride 2.
        val y = ByteBuffer.wrap(byteArrayOf(1, 2, 3, 4, 0, 0, 5, 6, 7, 8, 0, 0))
        val u = ByteBuffer.wrap(byteArrayOf(10, 0, 11, 0))
        val v = ByteBuffer.wrap(byteArrayOf(20, 0, 21, 0))
        val nv21 = ImageConversion.yuv420ToNv21(4, 2, PlaneData(y, 6, 1), PlaneData(u, 4, 2), PlaneData(v, 4, 2))
        assertArrayEquals(byteArrayOf(1, 2, 3, 4, 5, 6, 7, 8, 20, 10, 21, 11), nv21)
    }

    @Test
    fun packsDepthAsLittleEndianRowMajor() {
        // 2x2 DEPTH16 with a padded row stride of 6 bytes, stored in native order.
        val src = ByteBuffer.allocate(12).order(ByteOrder.nativeOrder())
        src.putShort(0, 1000)
        src.putShort(2, 2000)
        src.putShort(6, 3000)
        src.putShort(8, 65000.toShort())
        val packed = ImageConversion.packUint16LittleEndian(2, 2, PlaneData(src, 6, 2))
        val out = ByteBuffer.wrap(packed).order(ByteOrder.LITTLE_ENDIAN)
        assertEquals(8, packed.size)
        assertEquals(1000, out.getShort(0).toInt() and 0xffff)
        assertEquals(2000, out.getShort(2).toInt() and 0xffff)
        assertEquals(3000, out.getShort(4).toInt() and 0xffff)
        assertEquals(65000, out.getShort(6).toInt() and 0xffff)
    }

    @Test
    fun packsConfidenceBytes() {
        val src = ByteBuffer.wrap(byteArrayOf(1, 2, 9, 3, 4, 9))
        assertArrayEquals(byteArrayOf(1, 2, 3, 4), ImageConversion.packUint8(2, 2, PlaneData(src, 3, 1)))
    }
}
