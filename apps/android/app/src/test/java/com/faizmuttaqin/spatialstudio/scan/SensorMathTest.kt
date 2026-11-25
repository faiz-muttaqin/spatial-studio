package com.faizmuttaqin.spatialstudio.scan

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Random
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.sin

class SensorMathTest {
    private val rad = Math::toRadians

    /** Column-major camera-to-world pose looking along a world bearing (clockwise from -Z) and pitch up. */
    private fun poseLooking(bearingDeg: Double, pitchDeg: Double = 0.0): FloatArray {
        val b = rad(bearingDeg)
        val p = rad(pitchDeg)
        // Forward in the ARCore world (+X right, +Y up, -Z north of the plan).
        val forward = doubleArrayOf(sin(b) * cos(p), sin(p), -cos(b) * cos(p))
        // Camera -Z is forward: third column is -forward.
        val m = FloatArray(16)
        m[0] = 1f
        m[5] = 1f
        m[8] = (-forward[0]).toFloat()
        m[9] = (-forward[1]).toFloat()
        m[10] = (-forward[2]).toFloat()
        m[15] = 1f
        return m
    }

    /** Device orientation facing a compass azimuth with the camera horizontal (phone upright). */
    private fun orientationFacing(azimuthDeg: Double): Quaternion {
        val pitchUp = Quaternion.axisAngle(1.0, 0.0, 0.0, rad(90.0)) // camera -Z now points north
        val yaw = Quaternion.axisAngle(0.0, 0.0, 1.0, rad(-azimuthDeg)) // clockwise from north seen from above
        return yaw * pitchUp
    }

    @Test
    fun rotationVectorWithAndWithoutScalarGivesTheSameQuaternion() {
        val angle = rad(70.0)
        val s = sin(angle / 2).toFloat()
        val c = cos(angle / 2).toFloat()
        val withW = Quaternion.fromRotationVector(floatArrayOf(0.3f * s, 0.5f * s, 0.8124f * s, c, -1f))!!
        val withoutW = Quaternion.fromRotationVector(floatArrayOf(0.3f * s, 0.5f * s, 0.8124f * s))!!
        assertEquals(withW.w, withoutW.w, 1e-3)
        assertEquals(1.0, withW.x * withW.x + withW.y * withW.y + withW.z * withW.z + withW.w * withW.w, 1e-9)
    }

    @Test
    fun rejectsImplausibleRotationVectors() {
        assertNull(Quaternion.fromRotationVector(floatArrayOf(Float.NaN, 0f, 0f, 1f)))
        assertNull(Quaternion.fromRotationVector(floatArrayOf(0.9f, 0.9f, 0.9f)))
        assertNull(Quaternion.fromRotationVector(floatArrayOf(1f, 1f, 1f, 1f)))
        assertNull(Quaternion.fromRotationVector(floatArrayOf(0f, 0f)))
    }

    @Test
    fun anUprightPhoneHasTheCompassAzimuthItFaces() {
        for (azimuth in listOf(0.0, 45.0, 90.0, 180.0, 270.0, 359.0)) {
            val result = HeadingMath.cameraAzimuthDeg(orientationFacing(azimuth))!!
            assertEquals("azimuth $azimuth", 0.0, Angles.wrap180(result - azimuth), 1e-6)
        }
    }

    @Test
    fun aPhoneLyingFlatHasNoUsableAzimuth() {
        // Identity rotation: the back camera points straight down.
        assertNull(HeadingMath.cameraAzimuthDeg(Quaternion(0.0, 0.0, 0.0, 1.0)))
    }

    @Test
    fun worldBearingFollowsTheCameraAxes() {
        assertEquals(0.0, HeadingMath.worldBearingDeg(poseLooking(0.0))!!, 1e-4) // -Z
        assertEquals(90.0, HeadingMath.worldBearingDeg(poseLooking(90.0))!!, 1e-4) // +X
        assertEquals(180.0, HeadingMath.worldBearingDeg(poseLooking(180.0))!!, 1e-4) // +Z
        assertEquals(270.0, HeadingMath.worldBearingDeg(poseLooking(270.0))!!, 1e-4) // -X
        assertEquals(30.0, HeadingMath.worldBearingDeg(poseLooking(30.0, pitchDeg = 40.0))!!, 1e-3)
        assertNull(HeadingMath.worldBearingDeg(poseLooking(30.0, pitchDeg = 75.0)))
        assertNull(HeadingMath.worldBearingDeg(FloatArray(16) { Float.NaN }))
    }

    @Test
    fun wrapsAngles() {
        assertEquals(180.0, Angles.wrap180(-180.0), 0.0)
        assertEquals(-170.0, Angles.wrap180(190.0), 1e-9)
        assertEquals(10.0, Angles.wrap180(730.0), 1e-9)
        assertEquals(350.0, Angles.wrap360(-10.0), 1e-9)
        assertEquals(0.0, Angles.wrap360(360.0), 1e-9)
    }

    private fun reading(azimuth: Double, timestampNs: Long = 1_000_000_000L, accuracy: Double? = null) =
        OrientationReading(timestampNs, orientationFacing(azimuth), accuracy)

    @Test
    fun usesTheDeclinationOnlyWhenOneIsKnown() {
        val withDeclination = HeadingMath.sample(1_000_000_000L, poseLooking(10.0), reading(80.0), 3, 5.0, null)!!
        assertEquals(80.0, withDeclination.azimuthMagneticDeg, 1e-6)
        assertEquals(85.0, withDeclination.azimuthTrueDeg!!, 1e-6)
        assertEquals(5.0, withDeclination.declinationDeg!!, 0.0)

        val without = HeadingMath.sample(1_000_000_000L, poseLooking(10.0), reading(80.0), 3, null, null)!!
        assertNull(without.azimuthTrueDeg)
        assertNull(without.declinationDeg)

        val wrapped = HeadingMath.sample(1_000_000_000L, poseLooking(10.0), reading(358.0), 3, 5.0, null)!!
        assertEquals(3.0, wrapped.azimuthTrueDeg!!, 1e-6)
    }

    @Test
    fun skipsStaleOrientationOnlyWhenTheClocksMatch() {
        val old = reading(80.0, timestampNs = 1_000_000_000L)
        val frame = 1_300_000_000L
        assertNull(HeadingMath.sample(frame, poseLooking(10.0), old, 3, null, maxAgeNs = 100_000_000L))
        assertNotNull(HeadingMath.sample(frame, poseLooking(10.0), old, 3, null, maxAgeNs = null))
        assertNotNull(HeadingMath.sample(1_050_000_000L, poseLooking(10.0), old, 3, null, maxAgeNs = 100_000_000L))
    }

    @Test
    fun clampsMagnetometerAccuracy() {
        val s = HeadingMath.sample(1L, poseLooking(0.0), reading(0.0, timestampNs = 1L), 9, null, null)!!
        assertEquals(3, s.magnetometerAccuracy)
    }

    /** Synthetic walk: the world is rotated [northDeg] from the compass, with noise and bent-field outliers. */
    private fun synthetic(
        northDeg: Double,
        declinationDeg: Double?,
        count: Int = 300,
        noiseDeg: Double = 3.0,
        outlierEvery: Int = 7,
        accuracy: Int = 3,
        seed: Long = 7,
    ): List<HeadingData> {
        val random = Random(seed)
        return List(count) { i ->
            val bearing = Angles.wrap360(random.nextDouble() * 360.0)
            // Compass magnetic azimuth consistent with the world's north, plus noise.
            val trueAz = Angles.wrap360(bearing - northDeg)
            val magAz = Angles.wrap360(trueAz - (declinationDeg ?: 0.0) + random.nextGaussian() * noiseDeg)
            val bent = if (i % outlierEvery == 0) 40.0 else 0.0
            HeadingData(
                timestampNs = i * 200_000_000L,
                azimuthMagneticDeg = Angles.wrap360(magAz + bent),
                azimuthTrueDeg = declinationDeg?.let { Angles.wrap360(magAz + bent + it) },
                declinationDeg = declinationDeg,
                magnetometerAccuracy = accuracy,
                headingAccuracyDeg = null,
                worldBearingDeg = bearing,
            )
        }
    }

    private fun angleError(a: Double, b: Double) = abs(Angles.wrap180(a - b))

    @Test
    fun medianRecoversTrueNorthDespiteOutliers() {
        val result = NorthEstimator.estimate(synthetic(northDeg = 37.0, declinationDeg = 2.0))!!
        assertTrue(result.trueReference)
        assertEquals("compass-median-true", result.method)
        assertEquals(37.0, result.worldYawDeg, 2.0)
        assertEquals(2.0, result.declinationDeg!!, 1e-9)
        assertTrue("spread ${result.spreadDeg}", result.spreadDeg < 8.0)
        assertTrue("confidence ${result.confidence}", result.confidence > 0.6 && result.confidence <= 1.0)
        assertEquals(300, result.sampleCount)
    }

    @Test
    fun handlesTheWrapAroundAt180() {
        for (north in listOf(179.0, 180.0, -179.0, -90.0)) {
            val result = NorthEstimator.estimate(synthetic(northDeg = north, declinationDeg = 0.0))!!
            assertTrue("north $north got ${result.worldYawDeg}", angleError(result.worldYawDeg, north) < 2.5)
            assertTrue(result.worldYawDeg > -180.0 && result.worldYawDeg <= 180.0)
        }
    }

    @Test
    fun withoutALocationItReportsMagneticNorthAndSaysSo() {
        val result = NorthEstimator.estimate(synthetic(northDeg = -60.0, declinationDeg = null))!!
        assertFalse(result.trueReference)
        assertEquals("compass-median-magnetic", result.method)
        assertEquals("magnetic", result.reference)
        assertNull(result.declinationDeg)
        assertEquals(-60.0, result.worldYawDeg, 2.0)
    }

    @Test
    fun declinationShiftsTheTrueResultAgainstTheMagneticOne() {
        // The same readings, with and without a declination of +5 degrees (true = magnetic + 5).
        val magnetic = NorthEstimator.estimate(synthetic(northDeg = 20.0, declinationDeg = null, seed = 3))!!
        val withDeclination = NorthEstimator.estimate(
            synthetic(northDeg = 20.0, declinationDeg = null, seed = 3).map {
                HeadingData(
                    it.timestampNs, it.azimuthMagneticDeg, Angles.wrap360(it.azimuthMagneticDeg + 5.0), 5.0,
                    it.magnetometerAccuracy, it.headingAccuracyDeg, it.worldBearingDeg,
                )
            },
        )!!
        assertEquals(-5.0, Angles.wrap180(withDeclination.worldYawDeg - magnetic.worldYawDeg), 1e-6)
    }

    @Test
    fun ignoresPoorMagnetometerAndHeadingAccuracy() {
        val good = synthetic(northDeg = 10.0, declinationDeg = null, count = 40, outlierEvery = 1000)
        val bad = synthetic(northDeg = 150.0, declinationDeg = null, count = 400, seed = 11).mapIndexed { i, s ->
            HeadingData(
                s.timestampNs, s.azimuthMagneticDeg, null, null,
                magnetometerAccuracy = if (i % 2 == 0) 1 else 3,
                headingAccuracyDeg = if (i % 2 == 0) 5.0 else 60.0,
                worldBearingDeg = s.worldBearingDeg,
            )
        }
        // Every "bad" sample fails one filter, so only the good ones count.
        val result = NorthEstimator.estimate(good + bad)!!
        assertEquals(40, result.sampleCount)
        assertEquals(10.0, result.worldYawDeg, 2.0)
    }

    @Test
    fun tooFewUsableSamplesGiveNoEstimate() {
        assertNull(NorthEstimator.estimate(synthetic(30.0, null, count = NorthEstimator.MIN_SAMPLES - 1, outlierEvery = 1000)))
        assertNull(NorthEstimator.estimate(synthetic(30.0, null, count = 100, accuracy = 1)))
        assertNull(NorthEstimator.estimate(emptyList()))
    }

    @Test
    fun trueReferenceNeedsEnoughSamplesWithADeclination() {
        // Location arrives late: only 10 samples have a declination, so the result stays magnetic.
        val all = synthetic(northDeg = 5.0, declinationDeg = null, count = 100, outlierEvery = 1000)
        val late = all.mapIndexed { i, s ->
            if (i < 90) s else HeadingData(
                s.timestampNs, s.azimuthMagneticDeg, Angles.wrap360(s.azimuthMagneticDeg + 3.0), 3.0,
                s.magnetometerAccuracy, null, s.worldBearingDeg,
            )
        }
        assertFalse(NorthEstimator.estimate(late)!!.trueReference)
    }

    @Test
    fun confidenceFallsWithSpreadAndFewSamples() {
        val tight = NorthEstimator.estimate(synthetic(0.0, 0.0, count = 300, noiseDeg = 1.0, outlierEvery = 1000))!!
        val noisy = NorthEstimator.estimate(synthetic(0.0, 0.0, count = 300, noiseDeg = 25.0, outlierEvery = 1000))!!
        val few = NorthEstimator.estimate(synthetic(0.0, 0.0, count = 30, noiseDeg = 1.0, outlierEvery = 1000))!!
        assertTrue(tight.confidence > noisy.confidence)
        assertTrue(tight.confidence > few.confidence)
        assertTrue(noisy.spreadDeg > tight.spreadDeg)
        assertTrue(noisy.confidence in 0.0..1.0)
    }

    @Test
    fun circularMedianOfAnglesAcrossTheSeam() {
        val (median, spread) = NorthEstimator.circularMedian(listOf(178.0, 179.0, -179.0, -178.0, 180.0))
        assertTrue(angleError(median, 180.0) < 1.0)
        assertTrue(spread < 3.0)
    }

    @Test
    fun boundedSeriesLimitsRateAndCountAndFlagsTruncation() {
        val series = BoundedSeries<Int>(max = 3, minIntervalUnits = 10)
        assertTrue(series.offer(0, 0))
        assertFalse(series.offer(5, 1)) // too soon
        assertTrue(series.offer(10, 2))
        assertTrue(series.offer(25, 3))
        assertFalse(series.truncated)
        assertFalse(series.offer(40, 4)) // full
        assertTrue(series.truncated)
        assertEquals(listOf(0, 2, 3), series.snapshot())
        series.clear()
        assertEquals(0, series.size)
        assertFalse(series.truncated)
        assertTrue(series.offer(0, 9))
    }
}
