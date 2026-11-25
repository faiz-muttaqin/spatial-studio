package com.faizmuttaqin.spatialstudio.scan

/**
 * Back-projects a strided sample of a depth image into world space, for the live coverage grid.
 * Convention as the official ARCore raw depth sample and `depth-walls.ts`: `X = d(x - cx)/fx`,
 * `Y = d(cy - y)/fy`, `Z = -d`, with the pose a column-major camera-to-world matrix.
 */
object FloorSampler {
    fun interface Sink {
        fun add(x: Float, y: Float, z: Float)
    }

    /**
     * [depthMmAt] returns the depth in millimetres, 0 when there is none. [confidenceAt] is the raw
     * depth confidence 0..255, or null for smoothed depth (every pixel accepted).
     */
    fun sample(
        width: Int,
        height: Int,
        fx: Double,
        fy: Double,
        cx: Double,
        cy: Double,
        pose: FloatArray,
        stride: Int,
        depthMmAt: (Int, Int) -> Int,
        confidenceAt: ((Int, Int) -> Int)?,
        sink: Sink,
        minM: Float = MIN_DEPTH_M,
        maxM: Float = MAX_DEPTH_M,
        minConfidence: Int = MIN_CONFIDENCE,
    ): Int {
        if (width <= 0 || height <= 0 || fx <= 0.0 || fy <= 0.0 || stride <= 0 || pose.size != 16) return 0
        var added = 0
        var y = stride / 2
        while (y < height) {
            var x = stride / 2
            while (x < width) {
                val mm = depthMmAt(x, y)
                val d = mm / 1000f
                if (mm > 0 && d in minM..maxM && (confidenceAt == null || confidenceAt(x, y) >= minConfidence)) {
                    val px = (d * (x - cx) / fx).toFloat()
                    val py = (d * (cy - y) / fy).toFloat()
                    val pz = -d
                    sink.add(
                        pose[0] * px + pose[4] * py + pose[8] * pz + pose[12],
                        pose[1] * px + pose[5] * py + pose[9] * pz + pose[13],
                        pose[2] * px + pose[6] * py + pose[10] * pz + pose[14],
                    )
                    added++
                }
                x += stride
            }
            y += stride
        }
        return added
    }

    const val MIN_DEPTH_M = 0.2f
    const val MAX_DEPTH_M = 5f
    const val MIN_CONFIDENCE = 128
}
