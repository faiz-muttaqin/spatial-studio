package com.faizmuttaqin.spatialstudio.scan

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class KeyframeSelectorTest {
    private val second = 1_000_000_000L

    @Test
    fun firstTrackedFrameIsAKeyframe() {
        val selector = KeyframeSelector()
        assertFalse(selector.shouldCapture(0, tracking = false, pose = Matrices.pose()))
        assertTrue(selector.shouldCapture(0, tracking = true, pose = Matrices.pose()))
    }

    @Test
    fun capturesOnQuarterMetreOfMovement() {
        val selector = KeyframeSelector()
        selector.reserve(0, Matrices.pose())
        selector.commit()
        assertFalse(selector.shouldCapture(second, true, Matrices.pose(x = 0.2f)))
        assertTrue(selector.shouldCapture(second, true, Matrices.pose(x = 0.25f)))
        assertTrue(selector.shouldCapture(second, true, Matrices.pose(y = 0.15f, z = 0.2f)))
    }

    @Test
    fun capturesOnFifteenDegreesOfRotation() {
        val selector = KeyframeSelector()
        selector.reserve(0, Matrices.pose())
        selector.commit()
        assertFalse(selector.shouldCapture(second, true, Matrices.pose(yawDeg = 14.0)))
        assertTrue(selector.shouldCapture(second, true, Matrices.pose(yawDeg = 15.5)))
        assertTrue(selector.shouldCapture(second, true, Matrices.pose(yawDeg = -40.0)))
    }

    @Test
    fun respectsCustomSpacingAndMinimumInterval() {
        val selector = KeyframeSelector(spacingM = 0.5, angleDeg = 15.0, maxKeyframes = 10)
        selector.reserve(0, Matrices.pose())
        selector.commit()
        assertFalse(selector.shouldCapture(second, true, Matrices.pose(x = 0.3f)))
        assertTrue(selector.shouldCapture(second, true, Matrices.pose(x = 0.6f)))
        // Too soon after the previous keyframe, however far it moved.
        assertFalse(selector.shouldCapture(100_000_000L, true, Matrices.pose(x = 2f)))
    }

    @Test
    fun stopsAtTheKeyframeLimit() {
        val selector = KeyframeSelector(maxKeyframes = 2)
        selector.reserve(0, Matrices.pose())
        selector.commit()
        selector.reserve(second, Matrices.pose(x = 1f))
        selector.commit()
        assertTrue(selector.limitReached)
        assertEquals(2, selector.count)
        assertFalse(selector.shouldCapture(2 * second, true, Matrices.pose(x = 5f)))
    }

    @Test
    fun onlyStoredKeyframesCountAgainstTheBudget() {
        val selector = KeyframeSelector(maxKeyframes = 2)
        assertEquals(1, selector.reserve(0, Matrices.pose()))
        selector.release()
        assertEquals(0, selector.count)
        assertFalse(selector.limitReached)
        // The movement gate still restarts at the failed attempt.
        assertFalse(selector.shouldCapture(second, true, Matrices.pose(x = 0.1f)))
        assertEquals(2, selector.reserve(second, Matrices.pose(x = 1f)))
        selector.commit()
        assertEquals(1, selector.count)
    }

    @Test
    fun inFlightKeyframesHoldTheirSlot() {
        val selector = KeyframeSelector(maxKeyframes = 2)
        selector.reserve(0, Matrices.pose())
        selector.reserve(second, Matrices.pose(x = 1f))
        assertTrue(selector.limitReached)
        assertFalse(selector.shouldCapture(2 * second, true, Matrices.pose(x = 5f)))
        selector.release()
        assertFalse(selector.limitReached)
    }

    @Test
    fun ignoresNonFinitePoses() {
        val selector = KeyframeSelector()
        val bad = Matrices.pose().also { it[12] = Float.NaN }
        assertFalse(selector.shouldCapture(0, true, bad))
    }

    @Test
    fun rotationAngleIsSymmetric() {
        val a = Matrices.pose(yawDeg = 10.0)
        val b = Matrices.pose(yawDeg = 40.0)
        assertEquals(30.0, PoseMath.rotationAngleDeg(a, b), 1e-3)
        assertEquals(30.0, PoseMath.rotationAngleDeg(b, a), 1e-3)
        assertEquals(0.0, PoseMath.rotationAngleDeg(a, a), 1e-2)
    }
}
