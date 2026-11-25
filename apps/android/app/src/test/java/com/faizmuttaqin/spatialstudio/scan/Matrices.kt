package com.faizmuttaqin.spatialstudio.scan

import kotlin.math.cos
import kotlin.math.sin

/** Column-major camera-to-world matrices for tests. */
object Matrices {
    fun pose(x: Float = 0f, y: Float = 0f, z: Float = 0f, yawDeg: Double = 0.0): FloatArray {
        val r = Math.toRadians(yawDeg)
        val c = cos(r).toFloat()
        val s = sin(r).toFloat()
        // Rotation about +Y, then translation.
        return floatArrayOf(
            c, 0f, -s, 0f,
            0f, 1f, 0f, 0f,
            s, 0f, c, 0f,
            x, y, z, 1f,
        )
    }
}
