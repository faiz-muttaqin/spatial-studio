package com.faizmuttaqin.spatialstudio.scan

import kotlin.math.abs
import kotlin.math.acos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/** Position and orientation (unit quaternion) of a camera pose. */
data class QuatPose(
    val x: Float, val y: Float, val z: Float,
    val qx: Float, val qy: Float, val qz: Float, val qw: Float,
) {
    fun rotate(vx: Float, vy: Float, vz: Float): FloatArray {
        // v' = v + 2w(q x v) + 2 q x (q x v)
        val cx = qy * vz - qz * vy
        val cy = qz * vx - qx * vz
        val cz = qx * vy - qy * vx
        val dx = qy * cz - qz * cy
        val dy = qz * cx - qx * cz
        val dz = qx * cy - qy * cx
        return floatArrayOf(vx + 2 * (qw * cx + dx), vy + 2 * (qw * cy + dy), vz + 2 * (qw * cz + dz))
    }

    companion object {
        /** From a column-major camera-to-world matrix. */
        fun fromMatrix(m: FloatArray): QuatPose {
            val m00 = m[0]; val m10 = m[1]; val m20 = m[2]
            val m01 = m[4]; val m11 = m[5]; val m21 = m[6]
            val m02 = m[8]; val m12 = m[9]; val m22 = m[10]
            val trace = m00 + m11 + m22
            val qx: Float
            val qy: Float
            val qz: Float
            val qw: Float
            if (trace > 0f) {
                val s = sqrt(trace + 1f) * 2f
                qw = 0.25f * s
                qx = (m21 - m12) / s
                qy = (m02 - m20) / s
                qz = (m10 - m01) / s
            } else if (m00 > m11 && m00 > m22) {
                val s = sqrt(1f + m00 - m11 - m22) * 2f
                qw = (m21 - m12) / s
                qx = 0.25f * s
                qy = (m01 + m10) / s
                qz = (m02 + m20) / s
            } else if (m11 > m22) {
                val s = sqrt(1f + m11 - m00 - m22) * 2f
                qw = (m02 - m20) / s
                qx = (m01 + m10) / s
                qy = 0.25f * s
                qz = (m12 + m21) / s
            } else {
                val s = sqrt(1f + m22 - m00 - m11) * 2f
                qw = (m10 - m01) / s
                qx = (m02 + m20) / s
                qy = (m12 + m21) / s
                qz = 0.25f * s
            }
            return QuatPose(m[12], m[13], m[14], qx, qy, qz, qw)
        }
    }
}

/** What [PoseContinuity] made of one frame's camera pose. [integrates] says whether the frame may be recorded. */
enum class PoseStep(val integrates: Boolean) {
    Continuous(true),

    /** A small one-frame shift (centimetres, a few degrees): ARCore correcting its own drift. */
    Corrected(true),

    /** ARCore teleported the pose in one frame while still reporting TRACKING. */
    Slipped(false),

    /** Still off the trajectory the scan was built on. */
    Held(false),

    /** The pose jumped back onto the trajectory the scan was built on. */
    Recovered(true),
}

/**
 * Pose-jump guard: flags a frame whose pose moved further, or turned more, since the previous
 * frame than a hand-held phone can, while ARCore still says TRACKING. A large one-frame jump is
 * read as an offset of the whole world; nothing is recorded until a later jump undoes it.
 *
 * Ported from SceneView `PoseContinuity.kt` (samples/android-demo, `internal`), commit
 * 820e17c8537b, Apache-2.0. Adapted to column-major pose matrices; the hold-for-new-world and
 * stuck-for-the-screen parts are kept as [isStuck].
 */
class PoseContinuity(
    private val maxMetresPerSecond: Float = MAX_METRES_PER_SECOND,
    private val maxDegreesPerSecond: Float = MAX_DEGREES_PER_SECOND,
    private val slipMetres: Float = SLIP_METRES,
    private val slipDegrees: Float = SLIP_DEGREES,
    private val recoverMetres: Float = RECOVER_METRES,
    private val recoverDegrees: Float = RECOVER_DEGREES,
    private val stuckAfterNanos: Long = STUCK_AFTER_NANOS,
) {
    private var last: QuatPose? = null
    private var lastNanos = 0L
    private var lastNow = 0L
    private var anchor: QuatPose? = null
    private var offset = Offset.IDENTITY
    private var slipNanos = 0L

    val isSlipped: Boolean get() = anchor != null
    val isStuck: Boolean get() = anchor != null && lastNow - slipNanos >= stuckAfterNanos

    /** The user says the pose is fine here: recording resumes from the current pose. */
    fun resume() {
        anchor = null
        offset = Offset.IDENTITY
    }

    /** Size of the jump seen by the most recent [Slipped] step. */
    var lastJumpMetres = 0f
        private set
    var lastJumpDegrees = 0f
        private set

    var corrections = 0
        private set
    var slips = 0
        private set

    fun step(nanos: Long, pose: QuatPose): PoseStep {
        val previous = last
        if (previous == null) {
            last = pose
            lastNanos = nanos
            lastNow = nanos
            return PoseStep.Continuous
        }
        if (nanos <= lastNanos) return if (isSlipped) PoseStep.Held else PoseStep.Continuous
        val dt = max(nanos - lastNanos, MIN_DT_NANOS) / NANOS_PER_SECOND
        val metres = distance(previous, pose)
        val degrees = angleDegrees(previous, pose)
        val jump = metres / dt > maxMetresPerSecond || degrees / dt > maxDegreesPerSecond
        val gap = nanos - lastNanos > GAP_NANOS
        last = pose
        lastNanos = nanos
        lastNow = nanos

        val held = anchor
        if (held == null) {
            return when {
                !jump -> PoseStep.Continuous
                metres < slipMetres && degrees < slipDegrees -> {
                    corrections++
                    PoseStep.Corrected
                }
                else -> {
                    anchor = previous
                    offset = Offset.between(previous, pose)
                    slipNanos = nanos
                    slips++
                    lastJumpMetres = metres
                    lastJumpDegrees = degrees
                    PoseStep.Slipped
                }
            }
        }
        if (!jump && !gap) {
            // Walked back onto the trajectory the scan was built on.
            if (distance(held, pose) < recoverMetres && angleDegrees(held, pose) < recoverDegrees) {
                anchor = null
                offset = Offset.IDENTITY
                return PoseStep.Recovered
            }
            return PoseStep.Held
        }
        val composed = Offset.between(previous, pose).then(offset)
        if (composed.degrees() < recoverDegrees && composed.displacementAt(held) < recoverMetres) {
            anchor = null
            offset = Offset.IDENTITY
            return PoseStep.Recovered
        }
        if (!jump) return PoseStep.Held
        offset = composed
        return PoseStep.Slipped
    }

    /** A rigid transform of the world: rotation (qx, qy, qz, qw), then translation. */
    private data class Offset(
        val qx: Float, val qy: Float, val qz: Float, val qw: Float,
        val tx: Float, val ty: Float, val tz: Float,
    ) {
        fun then(first: Offset): Offset {
            val q = mul(qx, qy, qz, qw, first.qx, first.qy, first.qz, first.qw)
            val r = rotation().rotate(first.tx, first.ty, first.tz)
            return Offset(q[0], q[1], q[2], q[3], r[0] + tx, r[1] + ty, r[2] + tz)
        }

        fun degrees(): Float = angleOf(qw)

        fun displacementAt(pose: QuatPose): Float {
            val r = rotation().rotate(pose.x, pose.y, pose.z)
            val dx = r[0] + tx - pose.x
            val dy = r[1] + ty - pose.y
            val dz = r[2] + tz - pose.z
            return sqrt(dx * dx + dy * dy + dz * dz)
        }

        private fun rotation() = QuatPose(0f, 0f, 0f, qx, qy, qz, qw)

        companion object {
            val IDENTITY = Offset(0f, 0f, 0f, 1f, 0f, 0f, 0f)

            /** The offset taking pose [from] onto pose [to]: `to = O · from`. */
            fun between(from: QuatPose, to: QuatPose): Offset {
                val q = mul(to.qx, to.qy, to.qz, to.qw, -from.qx, -from.qy, -from.qz, from.qw)
                val r = QuatPose(0f, 0f, 0f, q[0], q[1], q[2], q[3]).rotate(from.x, from.y, from.z)
                return Offset(q[0], q[1], q[2], q[3], to.x - r[0], to.y - r[1], to.z - r[2])
            }
        }
    }

    companion object {
        /** Faster than this between two frames is not a hand-held phone (reference peak: 1.46 m/s). */
        const val MAX_METRES_PER_SECOND = 2.5f
        const val MAX_DEGREES_PER_SECOND = 360f
        const val SLIP_METRES = 0.3f
        const val SLIP_DEGREES = 10f
        const val RECOVER_METRES = 0.2f
        const val RECOVER_DEGREES = 10f
        const val STUCK_AFTER_NANOS = 4_000_000_000L
        private const val MIN_DT_NANOS = 16_666_667L
        private const val GAP_NANOS = 250_000_000L
        private const val NANOS_PER_SECOND = 1e9f

        fun distance(a: QuatPose, b: QuatPose): Float {
            val dx = a.x - b.x
            val dy = a.y - b.y
            val dz = a.z - b.z
            return sqrt(dx * dx + dy * dy + dz * dz)
        }

        fun angleDegrees(a: QuatPose, b: QuatPose): Float {
            val na = sqrt(a.qx * a.qx + a.qy * a.qy + a.qz * a.qz + a.qw * a.qw)
            val nb = sqrt(b.qx * b.qx + b.qy * b.qy + b.qz * b.qz + b.qw * b.qw)
            if (na == 0f || nb == 0f) return 0f
            return angleOf((a.qx * b.qx + a.qy * b.qy + a.qz * b.qz + a.qw * b.qw) / (na * nb))
        }

        private fun angleOf(cosHalf: Float): Float =
            Math.toDegrees(2.0 * acos(min(1f, abs(cosHalf)).toDouble())).toFloat()

        private fun mul(
            ax: Float, ay: Float, az: Float, aw: Float,
            bx: Float, by: Float, bz: Float, bw: Float,
        ): FloatArray = floatArrayOf(
            aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw,
            aw * bw - ax * bx - ay * by - az * bz,
        )
    }
}
