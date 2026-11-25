package com.faizmuttaqin.spatialstudio.scan

import com.google.ar.core.LightEstimate
import kotlin.math.sqrt

/** ARCore light estimate of one keyframe; see CAPTURE_CONTRACT.md "Sensor streams (v1.1)". */
data class LightRecord(
    val keyframeId: String,
    val timestampNs: Long,
    /** `ambient-intensity` or `environmental-hdr`. */
    val mode: String,
    val valid: Boolean,
    val pixelIntensity: Double?,
    /** `r, g, b, gamma`. */
    val colorCorrection: DoubleArray?,
    /** Unit vector, world frame, ARCore sign convention. */
    val mainLightDirection: DoubleArray?,
    /** Linear `r, g, b`. */
    val mainLightIntensity: DoubleArray?,
)

object LightMath {
    /**
     * Builds the record for a mode. Ambient mode keeps intensity and colour correction, environmental
     * HDR keeps the main light; an invalid estimate or non-finite values keep nothing.
     */
    fun record(
        timestampNs: Long,
        hdr: Boolean,
        valid: Boolean,
        pixelIntensity: Float,
        colorCorrection: FloatArray?,
        direction: FloatArray?,
        intensity: FloatArray?,
    ): LightRecord {
        val mode = if (hdr) "environmental-hdr" else "ambient-intensity"
        val empty = LightRecord("", timestampNs, mode, false, null, null, null, null)
        if (!valid) return empty
        if (hdr) {
            val dir = direction?.takeIf { it.size >= 3 && it.take(3).all(Float::isFinite) }?.let { unit(it) }
            val rgb = intensity?.takeIf { it.size >= 3 && it.take(3).all { v -> v.isFinite() && v >= 0f } }
            if (dir == null || rgb == null) return empty
            return empty.copy(valid = true, mainLightDirection = dir, mainLightIntensity = doubleArrayOf(rgb[0].toDouble(), rgb[1].toDouble(), rgb[2].toDouble()))
        }
        val color = colorCorrection?.takeIf { it.size >= 4 && it.take(4).all(Float::isFinite) }
        if (!pixelIntensity.isFinite() || color == null) return empty
        return empty.copy(
            valid = true,
            pixelIntensity = pixelIntensity.toDouble().coerceIn(0.0, 1.0),
            colorCorrection = DoubleArray(4) { color[it].toDouble() },
        )
    }

    fun fromEstimate(estimate: LightEstimate, hdr: Boolean, timestampNs: Long): LightRecord {
        val valid = estimate.state == LightEstimate.State.VALID
        if (!valid) return record(timestampNs, hdr, false, 0f, null, null, null)
        return if (hdr) {
            record(timestampNs, true, true, 0f, null, estimate.environmentalHdrMainLightDirection, estimate.environmentalHdrMainLightIntensity)
        } else {
            val color = FloatArray(4).also { estimate.getColorCorrection(it, 0) }
            record(timestampNs, false, true, estimate.pixelIntensity, color, null, null)
        }
    }

    private fun unit(v: List<Float>): DoubleArray? {
        val x = v[0].toDouble()
        val y = v[1].toDouble()
        val z = v[2].toDouble()
        val n = sqrt(x * x + y * y + z * z)
        if (n < 1e-6) return null
        return doubleArrayOf(x / n, y / n, z / n)
    }

    private fun unit(v: FloatArray): DoubleArray? = unit(v.toList())
}
