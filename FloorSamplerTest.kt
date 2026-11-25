package com.faizmuttaqin.spatialstudio.scan

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class FloorSamplerTest {
    private class Collect : FloorSampler.Sink {
        val points = ArrayList<FloatArray>()
        override fun add(x: Float, y: Float, z: Float) { points.add(floatArrayOf(x, y, z)) }
    }

    @Test fun `centre pixel unprojects straight ahead`() {
        val out = Collect()
        // 8 x 8 image, stride 8: the single sample is pixel (4, 4), the principal point.
        val n = FloorSampler.sample(8, 8, 8.0, 8.0, 4.0, 4.0, Matrices.pose(x = 1f, y = 2f, z = 3f), 8, { _, _ -> 2000 }, null, out)
        assertEquals(1, n)
        assertEquals(1f, out.points[0][0], 1e-5f)
        assertEquals(2f, out.points[0][1], 1e-5f)
        assertEquals(1f, out.points[0][2], 1e-5f) // 3 - 2 m ahead along -Z
    }

    @Test fun `pixel below the centre looks down`() {
        val out = Collect()
        // fy = 4: a pixel 2 rows below the centre at 2 m depth is 1 m lower.
        FloorSampler.sample(8, 8, 4.0, 4.0, 4.0, 4.0, Matrices.pose(), 1, { x, y -> if (x == 4 && y == 6) 2000 else 0 }, null, out)
        assertEquals(1, out.points.size)
        assertEquals(-1f, out.points[0][1], 1e-5f)
    }

    @Test fun `yaw turns the sample into world space`() {
        val out = Collect()
        // Yaw +90 degrees about Y turns the forward (-Z) axis to -X.
        FloorSampler.sample(8, 8, 8.0, 8.0, 4.0, 4.0, Matrices.pose(yawDeg = 90.0), 8, { _, _ -> 1000 }, null, out)
        assertEquals(-1f, out.points[0][0], 1e-5f)
        assertEquals(0f, out.points[0][2], 1e-5f)
    }

    @Test fun `depth range and confidence filter samples`() {
        val out = Collect()
        val depth = intArrayOf(100, 6000, 1000, 1000)
        val conf = intArrayOf(255, 255, 255, 10)
        // 4 x 1 image, stride 1: too near, too far, ok, low confidence.
        val n = FloorSampler.sample(4, 1, 4.0, 4.0, 2.0, 0.0, Matrices.pose(), 1, { x, _ -> depth[x] }, { x, _ -> conf[x] }, out)
        assertEquals(1, n)
    }

    @Test fun `stride bounds the sample count`() {
        val out = Collect()
        val n = FloorSampler.sample(160, 90, 150.0, 150.0, 80.0, 45.0, Matrices.pose(), 6, { _, _ -> 1500 }, null, out)
        assertTrue(n in 300..450)
    }

    @Test fun `invalid intrinsics add nothing`() {
        val out = Collect()
        assertEquals(0, FloorSampler.sample(8, 8, 0.0, 8.0, 4.0, 4.0, Matrices.pose(), 1, { _, _ -> 1000 }, null, out))
    }
}
