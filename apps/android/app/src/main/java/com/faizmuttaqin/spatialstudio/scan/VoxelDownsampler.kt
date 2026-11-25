package com.faizmuttaqin.spatialstudio.scan

import kotlin.math.floor

/**
 * Accumulates world-space feature points into a voxel grid, one centroid per
 * voxel. Points below [minConfidence] are ignored. When the grid would exceed
 * [maxPoints] the voxel size doubles and the grid is rebuilt, so the cloud is
 * downsampled rather than truncated.
 */
class VoxelDownsampler(
    initialVoxelM: Double = 0.02,
    val maxPoints: Int = 200_000,
    val minConfidence: Float = 0.3f,
) {
    private class Cell(var x: Double, var y: Double, var z: Double, var weight: Long)

    var voxelSizeM: Double = initialVoxelM
        private set
    private var cells = HashMap<Long, Cell>()

    val size: Int get() = cells.size

    fun add(x: Float, y: Float, z: Float, confidence: Float) {
        if (confidence < minConfidence || !x.isFinite() || !y.isFinite() || !z.isFinite()) return
        insert(cells, x.toDouble(), y.toDouble(), z.toDouble(), 1)
        while (cells.size > maxPoints) coarsen()
    }

    /** Adds packed `x, y, z, confidence` quadruples, as ARCore's PointCloud buffer stores them. */
    fun addPacked(values: FloatArray, count: Int = values.size / 4) {
        for (i in 0 until count) {
            val o = i * 4
            add(values[o], values[o + 1], values[o + 2], values[o + 3])
        }
    }

    /**
     * Like [addPacked], but only points within [maxDistanceM] of the camera at ([cx], [cy], [cz]):
     * far feature points are mostly mismatches (glass, reflections) that float away from the walked path.
     */
    fun addPackedWithin(values: FloatArray, count: Int, cx: Float, cy: Float, cz: Float, maxDistanceM: Float) {
        val limit = maxDistanceM * maxDistanceM
        for (i in 0 until count) {
            val o = i * 4
            val dx = values[o] - cx
            val dy = values[o + 1] - cy
            val dz = values[o + 2] - cz
            if (dx * dx + dy * dy + dz * dz <= limit) add(values[o], values[o + 1], values[o + 2], values[o + 3])
        }
    }

    /** Centroids as `x, y, z` triples. */
    fun positions(): FloatArray {
        val out = FloatArray(cells.size * 3)
        var i = 0
        for (cell in cells.values) {
            out[i++] = (cell.x / cell.weight).toFloat()
            out[i++] = (cell.y / cell.weight).toFloat()
            out[i++] = (cell.z / cell.weight).toFloat()
        }
        return out
    }

    private fun insert(target: HashMap<Long, Cell>, x: Double, y: Double, z: Double, weight: Long) {
        val key = key(x, y, z)
        val cell = target[key]
        if (cell == null) {
            target[key] = Cell(x * weight, y * weight, z * weight, weight)
        } else {
            cell.x += x * weight
            cell.y += y * weight
            cell.z += z * weight
            cell.weight += weight
        }
    }

    private fun coarsen() {
        voxelSizeM *= 2
        val rebuilt = HashMap<Long, Cell>(cells.size / 4 + 16)
        for (cell in cells.values) {
            insert(rebuilt, cell.x / cell.weight, cell.y / cell.weight, cell.z / cell.weight, cell.weight)
        }
        cells = rebuilt
    }

    private fun key(x: Double, y: Double, z: Double): Long {
        val ix = floor(x / voxelSizeM).toLong() and MASK
        val iy = floor(y / voxelSizeM).toLong() and MASK
        val iz = floor(z / voxelSizeM).toLong() and MASK
        return (ix shl 42) or (iy shl 21) or iz
    }

    private companion object {
        const val MASK = (1L shl 21) - 1
    }
}
