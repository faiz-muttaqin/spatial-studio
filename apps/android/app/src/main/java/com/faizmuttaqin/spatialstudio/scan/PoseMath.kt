package com.faizmuttaqin.spatialstudio.scan

import kotlin.math.atan2
import kotlin.math.sqrt

/** Helpers for column-major 4x4 camera-to-world matrices. */
object PoseMath {
    fun translationDistance(a: FloatArray, b: FloatArray): Double {
        val dx = (a[12] - b[12]).toDouble()
        val dy = (a[13] - b[13]).toDouble()
        val dz = (a[14] - b[14]).toDouble()
        return sqrt(dx * dx + dy * dy + dz * dz)
    }

    /** Angle in degrees of the relative rotation between the upper 3x3 blocks. */
    fun rotationAngleDeg(a: FloatArray, b: FloatArray): Double {
        // R = A^T B. Element (i, j) is the dot product of column i of A and column j of B.
        fun r(i: Int, j: Int): Double {
            var sum = 0.0
            for (k in 0 until 3) sum += a[i * 4 + k].toDouble() * b[j * 4 + k].toDouble()
            return sum
        }
        // atan2 of the axis magnitude and the cosine stays accurate near 0 and 180 degrees, unlike acos.
        val cos = (r(0, 0) + r(1, 1) + r(2, 2) - 1.0) / 2.0
        val x = r(2, 1) - r(1, 2)
        val y = r(0, 2) - r(2, 0)
        val z = r(1, 0) - r(0, 1)
        val sin = sqrt(x * x + y * y + z * z) / 2.0
        return Math.toDegrees(atan2(sin, cos))
    }

    fun isFinite(m: FloatArray): Boolean = m.size == 16 && m.all { it.isFinite() }
}
