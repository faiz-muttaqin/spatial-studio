package com.faizmuttaqin.spatialstudio.scan

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

private const val FRAME_NS = 33_333_333L

private fun quat(x: Float = 0f, y: Float = 0f, z: Float = 0f, yawDeg: Double = 0.0) =
    QuatPose.fromMatrix(Matrices.pose(x, y, z, yawDeg))

class MotionGuardTest {
    /** Walks along X at [mps] for [seconds] at 30 Hz and returns the guard. */
    private fun walk(mps: Double, seconds: Double, guard: MotionGuard = MotionGuard(), turnDegPerSecond: Double = 0.0): MotionGuard {
        var t = 0L
        var x = 0.0
        var yaw = 0.0
        guard.update(t, quat())
        while (t < seconds * 1e9) {
            t += FRAME_NS
            x += mps * FRAME_NS / 1e9
            yaw += turnDegPerSecond * FRAME_NS / 1e9
            guard.update(t, quat(x = x.toFloat(), yawDeg = yaw))
        }
        return guard
    }

    @Test fun `a slow walk is calm`() {
        assertFalse(walk(0.3, 2.0).tooFast)
    }

    @Test fun `a fast walk trips the guard`() {
        assertTrue(walk(1.2, 1.0).tooFast)
    }

    @Test fun `a fast turn trips the guard`() {
        assertTrue(walk(0.0, 1.0, turnDegPerSecond = 120.0).tooFast)
    }

    @Test fun `a single jittery frame does not flash the hint`() {
        val guard = walk(0.2, 1.0)
        var t = 1_100_000_000L
        guard.update(t, quat(x = 0.2f + 0.04f)) // one frame at 0.2 + 1.2 m/s equivalent
        assertFalse(guard.tooFast)
    }

    @Test fun `the hint clears only below the hysteresis band`() {
        val guard = walk(1.0, 1.0)
        assertTrue(guard.tooFast)
        // Slow to 0.45 m/s: under the limit but not under 80 % of it for a while.
        var t = 1_000_000_000L
        var x = 1.0
        var cleared = false
        repeat(60) {
            t += FRAME_NS
            x += 0.45 * FRAME_NS / 1e9
            guard.update(t, quat(x = x.toFloat()))
            if (!guard.tooFast) cleared = true
        }
        // 0.45 m/s is above 0.4 m/s (80 % of 0.5): still held.
        assertFalse(cleared)
        repeat(60) {
            t += FRAME_NS
            x += 0.2 * FRAME_NS / 1e9
            guard.update(t, quat(x = x.toFloat()))
        }
        assertFalse(guard.tooFast)
    }

    @Test fun `a gap in poses restarts the measurement`() {
        val guard = walk(1.5, 1.0)
        assertTrue(guard.tooFast)
        guard.update(5_000_000_000L, quat(x = 50f))
        assertFalse(guard.tooFast)
        assertEquals(0.0, guard.speedMps, 0.0)
    }
}

class KeyframeGateTest {
    @Test fun `a due keyframe on a calm tracked frame is captured`() {
        assertEquals(KeyframeGate.Decision.CAPTURE, KeyframeGate.decide(due = true, integrates = true, tooFast = false, encoderBusy = false))
    }

    @Test fun `a due keyframe while moving too fast is skipped for speed`() {
        assertEquals(KeyframeGate.Decision.SKIP_FAST, KeyframeGate.decide(true, true, true, false))
    }

    @Test fun `nothing is captured while the pose is held`() {
        assertEquals(KeyframeGate.Decision.SKIP, KeyframeGate.decide(true, false, false, false))
        assertEquals(KeyframeGate.Decision.SKIP, KeyframeGate.decide(true, false, true, false))
    }

    @Test fun `no keyframe is due, or the encoder is busy, means no capture and no speed skip`() {
        assertEquals(KeyframeGate.Decision.SKIP, KeyframeGate.decide(false, true, true, false))
        assertEquals(KeyframeGate.Decision.SKIP, KeyframeGate.decide(true, true, true, true))
    }
}

class PoseContinuityTest {
    private val guard = PoseContinuity()
    private var t = 0L

    private fun step(pose: QuatPose): PoseStep {
        t += FRAME_NS
        return guard.step(t, pose)
    }

    @Test fun `ordinary walking is continuous`() {
        var x = 0f
        repeat(60) {
            x += 0.015f // 0.45 m/s
            assertEquals(PoseStep.Continuous, step(quat(x = x)))
        }
        assertEquals(0, guard.slips)
    }

    @Test fun `a small jump is a correction and keeps recording`() {
        step(quat())
        val s = step(quat(x = 0.12f)) // 12 cm in one frame: over the speed limit, under the slip size
        assertEquals(PoseStep.Corrected, s)
        assertTrue(s.integrates)
        assertEquals(1, guard.corrections)
    }

    @Test fun `a large jump while tracking stops recording and is measured`() {
        step(quat())
        val s = step(quat(x = 0.57f, yawDeg = 86.0))
        assertEquals(PoseStep.Slipped, s)
        assertFalse(s.integrates)
        assertEquals(0.57f, guard.lastJumpMetres, 1e-3f)
        assertEquals(86f, guard.lastJumpDegrees, 0.5f)
        assertEquals(1, guard.slips)
        assertTrue(guard.isSlipped)
    }

    @Test fun `frames after a slip are held until a jump undoes it`() {
        step(quat())
        step(quat(x = 0.6f, yawDeg = 80.0))
        repeat(10) { assertEquals(PoseStep.Held, step(quat(x = 0.6f, yawDeg = 80.0))) }
        val back = step(quat(x = 0.02f, yawDeg = 1.0))
        assertEquals(PoseStep.Recovered, back)
        assertTrue(back.integrates)
        assertFalse(guard.isSlipped)
        assertEquals(PoseStep.Continuous, step(quat(x = 0.03f, yawDeg = 1.0)))
    }

    @Test fun `a second jump that does not undo the first stays held`() {
        step(quat())
        step(quat(x = 0.6f))
        val s = step(quat(x = 3f, yawDeg = 90.0))
        assertEquals(PoseStep.Slipped, s)
        assertTrue(guard.isSlipped)
    }

    @Test fun `a held scan is stuck after four seconds`() {
        step(quat())
        step(quat(x = 0.6f))
        assertFalse(guard.isStuck)
        repeat(130) { step(quat(x = 0.6f)) }
        assertTrue(guard.isStuck)
    }

    @Test fun `quaternion from matrix agrees with the pose angle`() {
        val a = quat(yawDeg = 10.0)
        val b = quat(yawDeg = 100.0)
        assertEquals(90f, PoseContinuity.angleDegrees(a, b), 0.1f)
        assertEquals(1f, PoseContinuity.distance(quat(), quat(x = 1f)), 1e-6f)
    }

    @Test fun `quaternion from matrix handles every branch`() {
        // Yaws of 0, 100, 170 and 250 degrees exercise the trace and the largest-diagonal branches.
        for (yaw in listOf(0.0, 100.0, 170.0, 250.0)) {
            val q = quat(yawDeg = yaw)
            val norm = q.qx * q.qx + q.qy * q.qy + q.qz * q.qz + q.qw * q.qw
            assertEquals(1f, norm, 1e-4f)
            // The rotated forward vector matches the matrix column.
            val m = Matrices.pose(yawDeg = yaw)
            val f = q.rotate(0f, 0f, -1f)
            assertEquals(-m[8], f[0], 1e-4f)
            assertEquals(-m[10], f[2], 1e-4f)
        }
    }
}
