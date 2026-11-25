package com.faizmuttaqin.spatialstudio.scan

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

private const val FRAME_NS = 33_333_333L

private fun quat(x: Float = 0f, y: Float = 0f, z: Float = 0f, yawDeg: Double = 0.0) =
    QuatPose.fromMatrix(Matrices.pose(x, y, z, yawDeg))

class MotionGuardTest {
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
        guard.update(1_100_000_000L, quat(x = 0.24f))
        assertFalse(guard.tooFast)
    }

    @Test fun `the hint clears only below the hysteresis band`() {
        val guard = walk(1.0, 1.0)
        assertTrue(guard.tooFast)
        var t = 1_000_000_000L
        var x = 1.0
        var cleared = false
        // 0.45 m/s is under the limit but above 80 % of it: the hint stays.
        repeat(60) {
            t += FRAME_NS
            x += 0.45 * FRAME_NS / 1e9
            guard.update(t, quat(x = x.toFloat()))
            if (!guard.tooFast) cleared = true
        }
        assertFalse(cleared)
        repeat(60) {
            t += FRAME_NS
            x += 0.2 * FRAME_NS / 1e9
            guard.update(t, quat(x = x.toFloat()))
        }
        assertFalse(guard.tooFast)
    }

    @Test fun `an ordinary wall sweep hints but does not block keyframes`() {
        // 70 degrees per second: over the 45 hint limit, under the 90 keyframe limit.
        val guard = walk(0.0, 1.0, turnDegPerSecond = 70.0)
        assertTrue(guard.tooFast)
        assertFalse(guard.keyframesBlocked)
        assertTrue(walk(0.0, 1.0, turnDegPerSecond = 150.0).keyframesBlocked)
        assertTrue(walk(2.0, 1.0).keyframesBlocked)
        assertFalse(walk(0.8, 1.0).keyframesBlocked)
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
        assertEquals(KeyframeGate.Decision.CAPTURE, KeyframeGate.decide(due = true, integrates = true, blocked = false, encoderBusy = false))
    }

    @Test fun `a due keyframe while moving too fast is skipped for speed`() {
        assertEquals(KeyframeGate.Decision.SKIP_FAST, KeyframeGate.decide(true, true, true, false))
    }

    @Test fun `a keyframe held back too long is captured anyway`() {
        val hold = MotionGuard.KEYFRAME_MAX_HOLD_NS
        assertEquals(KeyframeGate.Decision.SKIP_FAST, KeyframeGate.decide(true, true, true, false, dueForNs = hold - 1))
        assertEquals(KeyframeGate.Decision.CAPTURE, KeyframeGate.decide(true, true, true, false, dueForNs = hold))
    }

    @Test fun `nothing is captured while the pose is held`() {
        assertEquals(KeyframeGate.Decision.SKIP, KeyframeGate.decide(true, false, false, false))
        assertEquals(KeyframeGate.Decision.SKIP, KeyframeGate.decide(true, false, true, false))
    }

    @Test fun `no keyframe due, or a busy encoder, is no capture and no speed skip`() {
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
            x += 0.015f
            assertEquals(PoseStep.Continuous, step(quat(x = x)))
        }
        assertEquals(0, guard.slips)
    }

    @Test fun `a small jump is a correction and keeps recording`() {
        step(quat())
        val s = step(quat(x = 0.12f))
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
        assertEquals(PoseStep.Slipped, step(quat(x = 3f, yawDeg = 90.0)))
        assertTrue(guard.isSlipped)
    }

    @Test fun `a held scan is stuck after four seconds`() {
        step(quat())
        step(quat(x = 0.6f))
        assertFalse(guard.isStuck)
        repeat(130) { step(quat(x = 0.6f)) }
        assertTrue(guard.isStuck)
    }

    @Test fun `manual resume lets recording continue from the current pose`() {
        step(quat())
        step(quat(x = 0.6f, yawDeg = 80.0))
        assertTrue(guard.isSlipped)
        guard.resume()
        assertFalse(guard.isSlipped)
        assertEquals(PoseStep.Continuous, step(quat(x = 0.61f, yawDeg = 80.0)))
    }

    @Test fun `walking back onto the old trajectory recovers without a jump`() {
        step(quat())
        step(quat(x = 0.6f, yawDeg = 80.0))
        // Walk back in small steps (under the jump limits): held until close to the old pose, then recovered.
        val steps = (1..60).map { step(quat(x = 0.6f - it * 0.0095f, yawDeg = 80.0 - it * 1.3)) }
        assertEquals(PoseStep.Held, steps.first())
        assertTrue(PoseStep.Recovered in steps)
        assertEquals(PoseStep.Continuous, step(quat(x = 0.03f, yawDeg = 2.0)))
    }

    @Test fun `angle and distance helpers`() {
        assertEquals(90f, PoseContinuity.angleDegrees(quat(yawDeg = 10.0), quat(yawDeg = 100.0)), 0.1f)
        assertEquals(1f, PoseContinuity.distance(quat(), quat(x = 1f)), 1e-6f)
    }

    @Test fun `quaternion from matrix handles every branch`() {
        for (yaw in listOf(0.0, 100.0, 170.0, 250.0)) {
            val q = quat(yawDeg = yaw)
            assertEquals(1f, q.qx * q.qx + q.qy * q.qy + q.qz * q.qz + q.qw * q.qw, 1e-4f)
            val m = Matrices.pose(yawDeg = yaw)
            val f = q.rotate(0f, 0f, -1f)
            assertEquals(-m[8], f[0], 1e-4f)
            assertEquals(-m[10], f[2], 1e-4f)
        }
    }
}
