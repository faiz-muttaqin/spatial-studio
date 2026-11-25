package com.faizmuttaqin.spatialstudio.scan

import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/** Unit quaternion, Hamilton convention. */
class Quaternion(val x: Double, val y: Double, val z: Double, val w: Double) {
    /** Rotates the vector `(vx, vy, vz)` by this quaternion. */
    fun rotate(vx: Double, vy: Double, vz: Double): DoubleArray {
        // v' = v + w t + q x t, with t = 2 (q x v)
        val tx = 2 * (y * vz - z * vy)
        val ty = 2 * (z * vx - x * vz)
        val tz = 2 * (x * vy - y * vx)
        return doubleArrayOf(
            vx + w * tx + (y * tz - z * ty),
            vy + w * ty + (z * tx - x * tz),
            vz + w * tz + (x * ty - y * tx),
        )
    }

    operator fun times(o: Quaternion) = Quaternion(
        w * o.x + x * o.w + y * o.z - z * o.y,
        w * o.y - x * o.z + y * o.w + z * o.x,
        w * o.z + x * o.y - y * o.x + z * o.w,
        w * o.w - x * o.x - y * o.y - z * o.z,
    )

    companion object {
        private const val NORM_TOLERANCE = 0.05

        /**
         * From an Android `TYPE_ROTATION_VECTOR` event: `x*sin(a/2), y*sin(a/2), z*sin(a/2)`,
         * optionally `cos(a/2)` as the fourth value. Returns null when the values are not a
         * plausible rotation (non-finite, or far from unit length).
         */
        fun fromRotationVector(values: FloatArray): Quaternion? {
            if (values.size < 3) return null
            val x = values[0].toDouble()
            val y = values[1].toDouble()
            val z = values[2].toDouble()
            if (!(x.isFinite() && y.isFinite() && z.isFinite())) return null
            val w = if (values.size >= 4 && values[3].isFinite() && values[3] >= -1f && values[3] <= 1f) {
                values[3].toDouble()
            } else {
                val rest = 1.0 - x * x - y * y - z * z
                if (rest < -NORM_TOLERANCE) return null
                sqrt(max(rest, 0.0))
            }
            val norm = sqrt(x * x + y * y + z * z + w * w)
            if (abs(norm - 1.0) > NORM_TOLERANCE) return null
            return Quaternion(x / norm, y / norm, z / norm, w / norm)
        }

        fun axisAngle(ax: Double, ay: Double, az: Double, angleRad: Double): Quaternion {
            val n = sqrt(ax * ax + ay * ay + az * az)
            val s = sin(angleRad / 2) / n
            return Quaternion(ax * s, ay * s, az * s, cos(angleRad / 2))
        }
    }
}

/** Angle helpers in degrees. */
object Angles {
    /** Wraps to (-180, 180]. */
    fun wrap180(deg: Double): Double {
        var d = deg % 360.0
        if (d > 180.0) d -= 360.0 else if (d <= -180.0) d += 360.0
        return d
    }

    /** Wraps to [0, 360). */
    fun wrap360(deg: Double): Double {
        val d = deg % 360.0
        return if (d < 0) d + 360.0 else d
    }
}

/** One camera-direction compass reading paired with the ARCore world bearing of the same direction. */
class HeadingData(
    val timestampNs: Long,
    val azimuthMagneticDeg: Double,
    /** Null without a declination. */
    val azimuthTrueDeg: Double?,
    val declinationDeg: Double?,
    /** Android accuracy status 0 to 3 of the magnetometer. */
    val magnetometerAccuracy: Int,
    val headingAccuracyDeg: Double?,
    val worldBearingDeg: Double,
)

/** Latest rotation-vector reading: device to east-north-up (magnetic north) rotation. */
class OrientationReading(val timestampNs: Long, val q: Quaternion, val headingAccuracyDeg: Double?)

object HeadingMath {
    /** The camera must look within 60 degrees of the horizontal: horizontal part of the view vector at least cos(60). */
    const val MIN_HORIZONTAL = 0.5

    /** Compass bearing in degrees [0, 360) of the device's back-camera direction, or null when looking too steeply. */
    fun cameraAzimuthDeg(q: Quaternion): Double? {
        val forward = q.rotate(0.0, 0.0, -1.0) // east, north, up
        if (hypot(forward[0], forward[1]) < MIN_HORIZONTAL) return null
        return Angles.wrap360(Math.toDegrees(atan2(forward[0], forward[1])))
    }

    /**
     * Bearing in degrees [0, 360), clockwise from world -Z seen from above, of an ARCore camera
     * pose (column-major camera-to-world), or null when looking too steeply.
     */
    fun worldBearingDeg(pose: FloatArray): Double? {
        if (!PoseMath.isFinite(pose)) return null
        val fx = -pose[8].toDouble()
        val fz = -pose[10].toDouble()
        if (hypot(fx, fz) < MIN_HORIZONTAL) return null
        return Angles.wrap360(Math.toDegrees(atan2(fx, -fz)))
    }

    /**
     * Pairs the latest orientation with a frame. [maxAgeNs] is null when the sensor and camera
     * clocks are not known to match, in which case the age is not checked.
     */
    fun sample(
        frameTimestampNs: Long,
        pose: FloatArray,
        orientation: OrientationReading,
        magnetometerAccuracy: Int,
        declinationDeg: Double?,
        maxAgeNs: Long?,
    ): HeadingData? {
        if (maxAgeNs != null && abs(frameTimestampNs - orientation.timestampNs) > maxAgeNs) return null
        val azimuth = cameraAzimuthDeg(orientation.q) ?: return null
        val world = worldBearingDeg(pose) ?: return null
        return HeadingData(
            timestampNs = frameTimestampNs,
            azimuthMagneticDeg = azimuth,
            azimuthTrueDeg = declinationDeg?.let { Angles.wrap360(azimuth + it) },
            declinationDeg = declinationDeg,
            magnetometerAccuracy = magnetometerAccuracy.coerceIn(0, 3),
            headingAccuracyDeg = orientation.headingAccuracyDeg,
            worldBearingDeg = world,
        )
    }
}

class TrueNorthResult(
    val worldYawDeg: Double,
    val confidence: Double,
    val trueReference: Boolean,
    val spreadDeg: Double,
    val sampleCount: Int,
    val declinationDeg: Double?,
) {
    val method: String get() = if (trueReference) "compass-median-true" else "compass-median-magnetic"
    val reference: String get() = if (trueReference) "true" else "magnetic"
}

/** Median estimate of the bearing of north in the ARCore world; see CAPTURE_CONTRACT.md "True north". */
object NorthEstimator {
    const val MIN_SAMPLES = 20
    const val MIN_MAGNETOMETER_ACCURACY = 2
    const val MAX_HEADING_ACCURACY_DEG = 25.0
    private const val FULL_CONFIDENCE_SAMPLES = 150.0
    private const val ZERO_CONFIDENCE_SPREAD_DEG = 30.0
    private const val MAD_TO_SIGMA = 1.4826

    fun isUsable(sample: HeadingData): Boolean =
        sample.magnetometerAccuracy >= MIN_MAGNETOMETER_ACCURACY &&
            (sample.headingAccuracyDeg == null || sample.headingAccuracyDeg <= MAX_HEADING_ACCURACY_DEG)

    /**
     * True north when at least [MIN_SAMPLES] usable samples carry a declination, else magnetic north
     * from all usable samples, else null.
     */
    fun estimate(samples: List<HeadingData>): TrueNorthResult? {
        val usable = samples.filter(::isUsable)
        val withDeclination = usable.filter { it.azimuthTrueDeg != null && it.declinationDeg != null }
        if (withDeclination.size >= MIN_SAMPLES) {
            val offsets = withDeclination.map { it.worldBearingDeg - it.azimuthTrueDeg!! }
            val declination = withDeclination.sumOf { it.declinationDeg!! } / withDeclination.size
            return result(offsets, true, declination)
        }
        if (usable.size >= MIN_SAMPLES) {
            return result(usable.map { it.worldBearingDeg - it.azimuthMagneticDeg }, false, null)
        }
        return null
    }

    private fun result(offsetsDeg: List<Double>, trueReference: Boolean, declination: Double?): TrueNorthResult {
        val (center, spread) = circularMedian(offsetsDeg)
        val sampleFactor = min(1.0, offsetsDeg.size / FULL_CONFIDENCE_SAMPLES)
        val spreadFactor = max(0.0, 1.0 - spread / ZERO_CONFIDENCE_SPREAD_DEG)
        return TrueNorthResult(Angles.wrap180(center), sampleFactor * spreadFactor, trueReference, spread, offsetsDeg.size, declination)
    }

    /** Circular median in degrees, and the robust spread (1.4826 x median absolute deviation). */
    fun circularMedian(anglesDeg: List<Double>): Pair<Double, Double> {
        require(anglesDeg.isNotEmpty())
        var s = 0.0
        var c = 0.0
        for (a in anglesDeg) {
            s += sin(Math.toRadians(a))
            c += cos(Math.toRadians(a))
        }
        val center = Math.toDegrees(atan2(s, c))
        val deviations = anglesDeg.map { Angles.wrap180(it - center) }
        val median = median(deviations)
        val spread = median(deviations.map { abs(it - median) }) * MAD_TO_SIGMA
        return Angles.wrap180(center + median) to spread
    }

    private fun median(values: List<Double>): Double {
        val sorted = values.sorted()
        val mid = sorted.size / 2
        return if (sorted.size % 2 == 1) sorted[mid] else (sorted[mid - 1] + sorted[mid]) / 2
    }
}

/**
 * Keeps at most [max] items, at least [minIntervalUnits] apart in the caller's timestamp unit.
 * Past the cap nothing more is stored and [truncated] is set, so the bundle can say so.
 */
class BoundedSeries<T>(private val max: Int, private val minIntervalUnits: Long) {
    private val items = ArrayList<T>()
    private var lastUnits = Long.MIN_VALUE

    @Volatile
    var truncated = false
        private set

    @Synchronized
    fun offer(timestampUnits: Long, item: T): Boolean {
        if (lastUnits != Long.MIN_VALUE && timestampUnits - lastUnits < minIntervalUnits) return false
        if (items.size >= max) {
            truncated = true
            return false
        }
        items.add(item)
        lastUnits = timestampUnits
        return true
    }

    @Synchronized
    fun snapshot(): List<T> = ArrayList(items)

    val size: Int @Synchronized get() = items.size

    @Synchronized
    fun clear() {
        items.clear()
        lastUnits = Long.MIN_VALUE
        truncated = false
    }
}
