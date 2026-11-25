package com.faizmuttaqin.spatialstudio.scan

import kotlin.math.abs
import kotlin.math.acos
import kotlin.math.sqrt

/**
 * Whether the camera is moving too fast for sharp photos, measured on consecutive tracked poses.
 * The limits and the pose-gap rule follow SceneView `ScanPhotoPolicy.kt` (`ScanPhotoMotion`),
 * commit 820e17c8537b, Apache-2.0. Speeds are smoothed so one noisy frame does not flash the
 * hint, and the hint clears only below [CLEAR_FRACTION] of the limit.
 */
class MotionGuard(
    private val maxSpeedMps: Double = MAX_SPEED_MPS,
    private val maxTurnDegPerSecond: Double = MAX_TURN_DEG_PER_SECOND,
) {
    private var previous: QuatPose? = null
    private var previousNanos = 0L
    private var speed = 0.0
    private var turn = 0.0

    /** True from the first frame over a limit until both are back under [CLEAR_FRACTION] of it. */
    var tooFast = false
        private set

    /**
     * Looser limit for holding back keyframes: ordinary wall sweeps run at 60 to 90 degrees per second, so the
     * 45 degrees per second of [tooFast] (a hint) must not starve the keyframe stream.
     */
    var keyframesBlocked = false
        private set

    val speedMps: Double get() = speed
    val turnDegPerSecond: Double get() = turn

    /** Call on every tracked frame. A gap in poses restarts the measurement. */
    fun update(nanos: Long, pose: QuatPose) {
        val last = previous
        val elapsed = nanos - previousNanos
        previous = pose
        previousNanos = nanos
        if (last == null || elapsed <= 0L || elapsed > MAX_POSE_GAP_NS) {
            speed = 0.0
            turn = 0.0
            tooFast = false
            keyframesBlocked = false
            return
        }
        val seconds = elapsed / 1e9
        val dx = (pose.x - last.x).toDouble()
        val dy = (pose.y - last.y).toDouble()
        val dz = (pose.z - last.z).toDouble()
        val instantSpeed = sqrt(dx * dx + dy * dy + dz * dz) / seconds
        val dot = abs(pose.qx * last.qx + pose.qy * last.qy + pose.qz * last.qz + pose.qw * last.qw)
        val instantTurn = Math.toDegrees(2 * acos(dot.coerceIn(0f, 1f).toDouble())) / seconds
        speed += SMOOTHING * (instantSpeed - speed)
        turn += SMOOTHING * (instantTurn - turn)
        keyframesBlocked = speed > KEYFRAME_MAX_SPEED_MPS || turn > KEYFRAME_MAX_TURN_DEG_PER_SECOND
        tooFast = if (tooFast) {
            speed > maxSpeedMps * CLEAR_FRACTION || turn > maxTurnDegPerSecond * CLEAR_FRACTION
        } else {
            speed > maxSpeedMps || turn > maxTurnDegPerSecond
        }
    }

    fun reset() {
        previous = null
        speed = 0.0
        turn = 0.0
        tooFast = false
        keyframesBlocked = false
    }

    companion object {
        const val MAX_SPEED_MPS = 0.5
        const val MAX_TURN_DEG_PER_SECOND = 45.0
        /** Keyframes are held back only above these, and never longer than [KEYFRAME_MAX_HOLD_NS]. */
        const val KEYFRAME_MAX_SPEED_MPS = 1.2
        const val KEYFRAME_MAX_TURN_DEG_PER_SECOND = 90.0
        const val KEYFRAME_MAX_HOLD_NS = 1_500_000_000L
        const val MAX_POSE_GAP_NS = 250_000_000L
        private const val SMOOTHING = 0.4
        private const val CLEAR_FRACTION = 0.8
    }
}

/** Whether a keyframe due now is taken. Pure so the gating is tested without ARCore. */
object KeyframeGate {
    enum class Decision { CAPTURE, SKIP_FAST, SKIP }

    /**
     * [due]: the movement gate of the [KeyframeSelector] says a keyframe is due.
     * [blocked]: moving faster than the keyframe limits; a keyframe due for [dueForNs] or longer is taken anyway.
     * [integrates]: the pose guard allows recording. [encoderBusy]: encode queue is full.
     */
    fun decide(
        due: Boolean,
        integrates: Boolean,
        blocked: Boolean,
        encoderBusy: Boolean,
        dueForNs: Long = 0L,
        maxHoldNs: Long = MotionGuard.KEYFRAME_MAX_HOLD_NS,
    ): Decision = when {
        !due || !integrates || encoderBusy -> Decision.SKIP
        blocked && dueForNs < maxHoldNs -> Decision.SKIP_FAST
        else -> Decision.CAPTURE
    }
}
