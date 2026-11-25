package com.faizmuttaqin.spatialstudio.scan

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class VoxelDownsamplerTest {

    @Test
    fun mergesPointsInOneVoxelToTheirCentroid() {
        val voxels = VoxelDownsampler(initialVoxelM = 0.1)
        voxels.add(0.01f, 0.01f, 0.01f, 1f)
        voxels.add(0.03f, 0.05f, 0.07f, 1f)
        assertEquals(1, voxels.size)
        val p = voxels.positions()
        assertEquals(0.02f, p[0], 1e-6f)
        assertEquals(0.03f, p[1], 1e-6f)
        assertEquals(0.04f, p[2], 1e-6f)
    }

    @Test
    fun dropsLowConfidenceAndNonFinitePoints() {
        val voxels = VoxelDownsampler(initialVoxelM = 0.1)
        voxels.add(0f, 0f, 0f, 0.29f)
        voxels.add(Float.NaN, 0f, 0f, 1f)
        assertEquals(0, voxels.size)
        voxels.add(0f, 0f, 0f, 0.3f)
        assertEquals(1, voxels.size)
    }

    @Test
    fun negativeCoordinatesUseTheirOwnVoxels() {
        val voxels = VoxelDownsampler(initialVoxelM = 0.1)
        voxels.add(-0.01f, 0.05f, 0.05f, 1f)
        voxels.add(0.01f, 0.05f, 0.05f, 1f)
        assertEquals(2, voxels.size)
    }

    @Test
    fun readsPackedArcoreQuadruples() {
        val voxels = VoxelDownsampler(initialVoxelM = 0.1)
        voxels.addPacked(floatArrayOf(0f, 0f, 0f, 0.9f, 1f, 1f, 1f, 0.1f, 2f, 2f, 2f, 0.8f))
        assertEquals(2, voxels.size)
    }

    @Test
    fun coarsensInsteadOfTruncating() {
        val voxels = VoxelDownsampler(initialVoxelM = 0.01, maxPoints = 1000)
        // A 1 m x 1 m grid of 2,500 points, each in its own 1 cm voxel.
        for (i in 0 until 50) for (j in 0 until 50) voxels.add(i * 0.02f + 0.005f, 0f, j * 0.02f + 0.005f, 1f)
        assertTrue(voxels.size <= 1000)
        assertTrue(voxels.voxelSizeM > 0.01)
        // Coverage is kept: the cloud still spans the whole grid.
        val xs = voxels.positions().filterIndexed { index, _ -> index % 3 == 0 }
        assertTrue(xs.min() < 0.1f)
        assertTrue(xs.max() > 0.9f)
    }

    @Test
    fun dropsPointsFartherThanTheLimitFromTheCamera() {
        val voxels = VoxelDownsampler(initialVoxelM = 0.1)
        // Camera at (10, 0, 0): the first point is 3 m away, the second 9 m, the third exactly at 8 m.
        voxels.addPackedWithin(floatArrayOf(13f, 0f, 0f, 0.9f, 1f, 0f, 0f, 0.9f, 10f, 0f, 8f, 0.9f), 3, 10f, 0f, 0f, 8f)
        assertEquals(2, voxels.size)
    }
}
