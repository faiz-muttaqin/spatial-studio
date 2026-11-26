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

    /** Why [sample] would return null for these inputs, or "ok". Used to explain an empty heading stream. */
    fun diagnose(frameTimestampNs: Long, pose: FloatArray, orientation: OrientationReading?, maxAgeNs: Long): String = when {
        orientation == null -> "no-orientation"
        abs(frameTimestampNs - orientation.timestampNs) > maxAgeNs -> "pair-age"
        cameraAzimuthDeg(orientation.q) == null -> "camera-steep"
        worldBearingDeg(pose) == null -> "world-steep"
        else -> "ok"
    }

    /**
     * Pairs an orientation with a frame. [maxAgeNs] is null when the sensor and camera
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
    /** False when the offsets of separate tracking segments disagree (a world-frame jump or a bent field). */
    val segmentsAgree: Boolean = true,
    /** True when the segments disagreed and this is the best supported segment alone. */
    val fromSegment: Boolean = false,
    /** Frame timestamps (ns) of the first and last sample of the segment [fromSegment] used; null otherwise. */
    val segmentStartNs: Long? = null,
    val segmentEndNs: Long? = null,
) {
    val method: String get() = if (trueReference) "compass-median-true" else "compass-median-magnetic"
    val reference: String get() = if (trueReference) "true" else "magnetic"
}

/** Source of the magnetic declination in degrees (east positive); the real one wraps `GeomagneticField`. */
fun interface DeclinationSource {
    fun declination(latitude: Double, longitude: Double, altitudeM: Double, timeMs: Long): Double?
}

object Declination {
    /** Mean declination of the retained fixes, or null without a usable one. */
    fun fromFixes(fixes: List<LocationFix>, source: DeclinationSource): Double? {
        val values = fixes.mapNotNull { source.declination(it.latitude, it.longitude, it.altitudeM ?: 0.0, it.timestampMs) }
            .filter { it.isFinite() }
        return if (values.isEmpty()) null else values.sum() / values.size
    }

    /** Magnetic-only samples to samples that also carry the true azimuth. */
    fun apply(samples: List<HeadingData>, declinationDeg: Double?): List<HeadingData> =
        if (declinationDeg == null) samples else samples.map {
            HeadingData(
                it.timestampNs, it.azimuthMagneticDeg, Angles.wrap360(it.azimuthMagneticDeg + declinationDeg), declinationDeg,
                it.magnetometerAccuracy, it.headingAccuracyDeg, it.worldBearingDeg,
            )
        }
}

/** Median estimate of the bearing of north in the ARCore world; see CAPTURE_CONTRACT.md "True north". */
object NorthEstimator {
    const val MIN_SAMPLES = 20
    const val MIN_MAGNETOMETER_ACCURACY = 2
    const val MAX_HEADING_ACCURACY_DEG = 25.0
    private const val FULL_CONFIDENCE_WINDOWS = 30.0
    private const val WINDOW_NS = 2_000_000_000L
    private const val ZERO_CONFIDENCE_SPREAD_DEG = 30.0
    private const val FULL_COVERAGE_SPAN_DEG = 180.0
    private const val MEDIUM_ACCURACY_CAP = 0.6
    private const val DISAGREE_CAP = 0.3
    private const val SEGMENT_GAP_NS = 1_000_000_000L
    private const val MIN_SEGMENT_SAMPLES = 10
    private const val SEGMENT_DISAGREE_DEG = 15.0
    private const val MAD_TO_SIGMA = 1.4826

    /** Why [estimate] has no result: a short reason for the bundle's warnings. */
    fun unavailableReason(samples: List<HeadingData>): String {
        if (samples.isEmpty()) return "no-heading-samples"
        val usable = samples.count(::isUsable)
        return when {
            usable >= MIN_SAMPLES -> "estimator"
            usable < samples.size / 2 -> "magnetometer-accuracy-low:usable=$usable/${samples.size}"
            else -> "too-few-samples:usable=$usable/$MIN_SAMPLES"
        }
    }

    /**
     * True when the compass reports an accuracy whose readings [isUsable] would drop, so north needs a calibration
     * first. Null (no reading yet, or no magnetometer) is not a reason to ask.
     */
    fun needsCalibration(magnetometerAccuracy: Int?): Boolean =
        magnetometerAccuracy != null && magnetometerAccuracy < MIN_MAGNETOMETER_ACCURACY

    fun isUsable(sample: HeadingData): Boolean =
        sample.magnetometerAccuracy >= MIN_MAGNETOMETER_ACCURACY &&
            (sample.headingAccuracyDeg == null || sample.headingAccuracyDeg <= MAX_HEADING_ACCURACY_DEG)

    /**
     * True north when at least [MIN_SAMPLES] usable samples carry a declination, else magnetic north
     * from all usable samples, else null.
     */
    fun estimate(samples: List<HeadingData>): TrueNorthResult? {
        val usable = samples.filter(::isUsable).sortedBy { it.timestampNs }
        val withDeclination = usable.filter { it.azimuthTrueDeg != null && it.declinationDeg != null }
        if (withDeclination.size >= MIN_SAMPLES) {
            val declination = withDeclination.sumOf { it.declinationDeg!! } / withDeclination.size
            return bySegments(withDeclination, true, declination)
        }
        if (usable.size >= MIN_SAMPLES) return bySegments(usable, false, null)
        return null
    }

    /**
     * When the tracking segments agree, all samples are used. When they disagree (a world-frame jump
     * between segments), each segment with enough samples is estimated alone and the best supported one
     * is returned, flagged `segmentsAgree = false` and with [TrueNorthResult.fromSegment] set, instead of
     * one low-confidence figure across segments that do not share a frame.
     */
    private fun bySegments(samples: List<HeadingData>, trueReference: Boolean, declination: Double?): TrueNorthResult {
        val overall = result(samples, trueReference, declination)
        if (overall.segmentsAgree) return overall
        // The same minimum as the agreement test, so a segment that made the overall estimate disagree can be chosen.
        val candidates = splitSegments(samples).filter { it.size >= MIN_SEGMENT_SAMPLES }
        val best = candidates
            .map { it to result(it, trueReference, declination) }
            .maxWithOrNull(compareBy<Pair<List<HeadingData>, TrueNorthResult>> { it.second.confidence }.thenBy { it.second.sampleCount })
            ?: return overall
        val (segment, r) = best
        return TrueNorthResult(
            r.worldYawDeg, r.confidence, r.trueReference, r.spreadDeg, r.sampleCount,
            r.declinationDeg, segmentsAgree = false, fromSegment = true,
            segmentStartNs = segment.first().timestampNs, segmentEndNs = segment.last().timestampNs,
        )
    }

    private fun splitSegments(samples: List<HeadingData>): List<List<HeadingData>> {
        val segments = ArrayList<MutableList<HeadingData>>()
        var previous = Long.MIN_VALUE
        for (s in samples) {
            if (previous == Long.MIN_VALUE || s.timestampNs - previous > SEGMENT_GAP_NS) segments.add(ArrayList())
            segments.last().add(s)
            previous = s.timestampNs
        }
        return segments
    }

    private fun offset(s: HeadingData, trueReference: Boolean): Double =
        s.worldBearingDeg - (if (trueReference) s.azimuthTrueDeg!! else s.azimuthMagneticDeg)

    private fun result(samples: List<HeadingData>, trueReference: Boolean, declination: Double?): TrueNorthResult {
        val offsets = samples.map { offset(it, trueReference) }
        val (center, spread) = circularMedian(offsets)

        // Autocorrelated 5 Hz samples count once per 2 s window.
        val windows = samples.map { it.timestampNs / WINDOW_NS }.toSet().size
        val sampleFactor = min(1.0, windows / FULL_CONFIDENCE_WINDOWS)
        val spreadFactor = max(0.0, 1.0 - spread / ZERO_CONFIDENCE_SPREAD_DEG)
        val coverageFactor = min(1.0, bearingSpanDeg(samples.map { it.worldBearingDeg }) / FULL_COVERAGE_SPAN_DEG)
        val accuracies = samples.map { it.magnetometerAccuracy }.sorted()
        val accuracyCap = if (accuracies[accuracies.size / 2] >= 3) 1.0 else MEDIUM_ACCURACY_CAP

        val agree = segmentsAgree(samples, offsets, center)
        var confidence = min(accuracyCap, sampleFactor * spreadFactor * coverageFactor)
        if (!agree) confidence = min(confidence, DISAGREE_CAP)
        return TrueNorthResult(Angles.wrap180(center), confidence, trueReference, spread, samples.size, declination, agree)
    }

    /** Angular range covered by bearings: 360 minus the largest gap between neighbours on the circle. */
    fun bearingSpanDeg(bearings: List<Double>): Double {
        if (bearings.size < 2) return 0.0
        val sorted = bearings.map(Angles::wrap360).sorted()
        var largestGap = sorted.first() + 360.0 - sorted.last()
        for (i in 1 until sorted.size) largestGap = max(largestGap, sorted[i] - sorted[i - 1])
        return 360.0 - largestGap
    }

    /** Samples are split where more than one second passes (tracking loss); each segment's median must match the overall one. */
    private fun segmentsAgree(samples: List<HeadingData>, offsets: List<Double>, center: Double): Boolean {
        val segments = ArrayList<MutableList<Double>>()
        var previous = Long.MIN_VALUE
        samples.forEachIndexed { i, s ->
            if (previous == Long.MIN_VALUE || s.timestampNs - previous > SEGMENT_GAP_NS) segments.add(ArrayList())
            segments.last().add(offsets[i])
            previous = s.timestampNs
        }
        return segments.filter { it.size >= MIN_SEGMENT_SAMPLES }
            .all { abs(Angles.wrap180(circularMedian(it).first - center)) <= SEGMENT_DISAGREE_DEG }
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
 * Checks that a clock reported by a callback (ARCore frame timestamps, sensor events) is the boot-time
 * clock, by comparing each reading with `SystemClock.elapsedRealtimeNanos()` taken as it arrives. On the
 * same clock the difference is the delivery delay: small, non-negative and steady.
 */
class ClockCalibrator(
    private val required: Int = 30,
    private val minDeltaNs: Long = -5_000_000L,
    private val maxDeltaNs: Long = 250_000_000L,
    private val maxSpreadNs: Long = 100_000_000L,
) {
    enum class State { PENDING, COMPARABLE, MISMATCH }

    @Volatile
    var state = State.PENDING
        private set

    private var count = 0
    private var lowest = Long.MAX_VALUE
    private var highest = Long.MIN_VALUE

    /** [readingNs] is the callback's timestamp, [elapsedNs] the boot-time clock on arrival. */
    fun add(readingNs: Long, elapsedNs: Long) {
        if (state != State.PENDING || readingNs <= 0L) return
        val delta = elapsedNs - readingNs
        if (delta < minDeltaNs || delta > maxDeltaNs) {
            state = State.MISMATCH
            return
        }
        lowest = min(lowest, delta)
        highest = max(highest, delta)
        count++
        if (count >= required) state = if (highest - lowest <= maxSpreadNs) State.COMPARABLE else State.MISMATCH
    }
}

/**
 * Estimates how far ARCore's frame timestamps are from the boot-time clock the sensors use, continuously.
 *
 * Each frame gives `elapsedRealtimeNanos()` at delivery minus `frame.timestamp`: the delivery latency (always
 * positive, with spikes) plus the clock base difference. A low percentile of a sliding window ignores the
 * spikes. With the torch on, device scans showed frame timestamps that were not on the sensors' base from the
 * start, so a check that only accepts the boot clock paired no headings at all.
 *
 * - A low percentile within [bootClockMaxNs] means the frame clock is the boot clock: [offsetNs] is 0.
 * - Otherwise [offsetNs] is the percentile minus a nominal delivery latency, and frame times are mapped
 *   onto the sensor clock with it ([method] `low-percentile`). The error is about the spread of the latency.
 */
class FrameClockEstimator(
    private val window: Int = 60,
    private val minSamples: Int = 20,
    private val percentile: Double = 0.1,
    private val nominalLatencyNs: Long = 30_000_000L,
    /**
     * A low percentile up to this is taken as delivery latency on the boot clock. Real latency on a busy GL thread
     * can pass 100 ms, and an offset smaller than this cannot be told from latency: it is left unapplied.
     */
    private val bootClockMaxNs: Long = 500_000_000L,
    private val bootClockMinNs: Long = -5_000_000L,
    /** The percentiles are recomputed every this many frames, not on every frame. */
    private val refreshEvery: Int = 5,
) {
    private val deltas = ArrayDeque<Long>()
    private var sinceRefresh = 0

    /** Add to a frame timestamp to get the sensor clock's time of the same instant. Valid once [ready]. */
    @Volatile
    var offsetNs = 0L
        private set

    @Volatile
    var ready = false
        private set

    /** `boot-clock` or `low-percentile`. */
    @Volatile
    var method = METHOD_BOOT_CLOCK
        private set

    /** The extremes of [offsetNs] over the scan, and how many frames went into the estimate. */
    @Volatile
    var minOffsetNs = 0L
        private set

    @Volatile
    var maxOffsetNs = 0L
        private set

    @Volatile
    var frames = 0
        private set

    /** True once any frame needed an offset, so frame and sensor timestamps are not directly comparable. */
    @Volatile
    var offsetApplied = false
        private set

    /** The 10th, 50th and 90th percentile of delivery delta in the window at the last refresh, for offline diagnosis. */
    @Volatile
    var deltaP10Ns = 0L
        private set

    @Volatile
    var deltaP50Ns = 0L
        private set

    @Volatile
    var deltaP90Ns = 0L
        private set

    /**
     * Forgets the window: call after anything that can move the frame clock's base (a session reconfigure), so the
     * old base cannot outvote the new one. Not [ready] again until [minSamples] frames have arrived.
     */
    fun reset() {
        deltas.clear()
        sinceRefresh = 0
        ready = false
    }

    /** [frameNs] is `frame.timestamp`, [elapsedNs] the boot-time clock as the frame was delivered. */
    fun add(frameNs: Long, elapsedNs: Long) {
        if (frameNs <= 0L) return
        deltas.addLast(elapsedNs - frameNs)
        if (deltas.size > window) deltas.removeFirst()
        frames++
        if (deltas.size < minSamples) return
        // The first estimate comes as soon as the window is big enough, then every few frames.
        if (ready && ++sinceRefresh < refreshEvery) return
        sinceRefresh = 0
        val sorted = deltas.sorted()
        val low = sorted[((sorted.size - 1) * percentile).toInt()]
        deltaP10Ns = low
        deltaP50Ns = sorted[(sorted.size - 1) / 2]
        deltaP90Ns = sorted[((sorted.size - 1) * 0.9).toInt()]
        val onBootClock = low in bootClockMinNs..bootClockMaxNs
        offsetNs = if (onBootClock) 0L else low - nominalLatencyNs
        method = if (onBootClock) METHOD_BOOT_CLOCK else METHOD_LOW_PERCENTILE
        if (!ready && frames <= deltas.size) {
            minOffsetNs = offsetNs
            maxOffsetNs = offsetNs
        } else {
            minOffsetNs = min(minOffsetNs, offsetNs)
            maxOffsetNs = max(maxOffsetNs, offsetNs)
        }
        if (!onBootClock) offsetApplied = true
        ready = true
    }

    companion object {
        const val METHOD_BOOT_CLOCK = "boot-clock"
        const val METHOD_LOW_PERCENTILE = "low-percentile"
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

    /** Like [offer], but [allowed] is checked under the same lock as [clear], so a cleared stream cannot regain an item. */
    @Synchronized
    fun offerIf(timestampUnits: Long, item: T, allowed: () -> Boolean): Boolean = allowed() && offer(timestampUnits, item)

    /** Cheap pre-check so callers skip work for a sample [offer] would drop for rate. */
    @Synchronized
    fun accepts(timestampUnits: Long): Boolean =
        items.size < max && (lastUnits == Long.MIN_VALUE || timestampUnits - lastUnits >= minIntervalUnits)

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

/** Passes at most once per [intervalNs]; the first call always passes (no subtraction from a sentinel, which overflows). */
class IntervalGate(private val intervalNs: Long) {
    private var last = 0L
    private var started = false

    fun ready(timestampNs: Long): Boolean {
        if (started && timestampNs - last < intervalNs) return false
        started = true
        last = timestampNs
        return true
    }
}

/** The most recent orientation readings, so a frame can be paired with the reading nearest its capture time. */
class OrientationHistory(private val capacity: Int = 128) {
    private val readings = ArrayDeque<OrientationReading>()

    @Synchronized
    fun add(reading: OrientationReading) {
        if (readings.size >= capacity) readings.removeFirst()
        readings.addLast(reading)
    }

    @Synchronized
    fun nearest(timestampNs: Long): OrientationReading? = readings.minByOrNull { abs(it.timestampNs - timestampNs) }

    @Synchronized
    fun clear() = readings.clear()
}

/** Counts of frames dropped before they became heading samples, by reason. */
class HeadingDiagnostics {
    private val counts = java.util.TreeMap<String, Int>()

    @Synchronized
    fun count(reason: String) {
        counts[reason] = (counts[reason] ?: 0) + 1
    }

    @Synchronized
    fun summary(): String = counts.entries.joinToString(" ") { "${it.key}=${it.value}" }

    @Synchronized
    fun clear() = counts.clear()
}
