package com.faizmuttaqin.spatialstudio.scan

import kotlin.math.max

/** Picks the ARCore camera config whose CPU image is largest without exceeding the keyframe size limit. */
object CameraConfigChoice {
    class Candidate(val imageWidth: Int, val imageHeight: Int, val maxFps: Int)

    /** Index of the preferred candidate, or -1 for an empty list. */
    fun pick(candidates: List<Candidate>, maxLongEdge: Int = 1920): Int {
        if (candidates.isEmpty()) return -1
        val fitting = candidates.withIndex().filter { max(it.value.imageWidth, it.value.imageHeight) <= maxLongEdge }
        val pool = fitting.ifEmpty {
            // Everything is too large: take the smallest and downscale each keyframe.
            val smallest = candidates.minOf { it.imageWidth.toLong() * it.imageHeight }
            candidates.withIndex().filter { it.value.imageWidth.toLong() * it.value.imageHeight == smallest }
        }
        return pool.maxWith(
            compareBy<IndexedValue<Candidate>> { it.value.imageWidth.toLong() * it.value.imageHeight }
                .thenBy { if (it.value.maxFps >= 30) 1 else 0 }
                .thenBy { -it.index },
        ).index
    }
}
