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

class SensorTrustTest {
    private fun sample(tNs: Long, bearing: Double, offset: Double, accuracy: Int = 3) = HeadingData(
        tNs, Angles.wrap360(bearing - offset), null, null, accuracy, null, Angles.wrap360(bearing),
    )

    /** [seconds] of 5 Hz samples whose bearing sweeps 0..[sweepDeg]. */
    private fun run(startS: Double, seconds: Int, offset: Double, sweepDeg: Double = 270.0, accuracy: Int = 3): List<HeadingData> =
        List(seconds * 5) { i -> sample(((startS + i * 0.2) * 1e9).toLong(), sweepDeg * i / (seconds * 5), offset, accuracy) }

    @Test
    fun clockCalibratorAcceptsASteadyDeliveryDelay() {
        val c = ClockCalibrator()
        for (i in 0 until 30) c.add(1_000_000_000L + i * 33_000_000L, 1_000_000_000L + i * 33_000_000L + 40_000_000L + (i % 3) * 5_000_000L)
        assertEquals(ClockCalibrator.State.COMPARABLE, c.state)
    }

    @Test
    fun clockCalibratorRejectsADifferentClockOrAJitteryOne() {
        val other = ClockCalibrator()
        other.add(5_000_000_000L, 90_000_000_000L) // 85 s apart: not the boot-time clock
        assertEquals(ClockCalibrator.State.MISMATCH, other.state)
        val future = ClockCalibrator()
        future.add(10_000_000_000L, 9_000_000_000L) // a reading from the future
        assertEquals(ClockCalibrator.State.MISMATCH, future.state)
        val jitter = ClockCalibrator()
        for (i in 0 until 30) jitter.add(1_000_000_000L, 1_000_000_000L + (if (i % 2 == 0) 10_000_000L else 200_000_000L))
        assertEquals(ClockCalibrator.State.MISMATCH, jitter.state)
        val pending = ClockCalibrator()
        for (i in 0 until 10) pending.add(1_000_000_000L, 1_040_000_000L)
        assertEquals(ClockCalibrator.State.PENDING, pending.state)
    }

    @Test
    fun declinationComesFromTheFixesOnly() {
        val fixes = listOf(
            LocationFix(1L, 1.0, 103.0, null, 500.0, "network"),
            LocationFix(2L, 1.1, 103.1, 30.0, 500.0, "network"),
        )
        val source = DeclinationSource { lat, _, alt, _ -> if (alt > 0) 1.0 else 3.0 + lat * 0 }
        assertEquals(2.0, Declination.fromFixes(fixes, source)!!, 1e-9)
        assertNull(Declination.fromFixes(emptyList(), source))
        assertNull(Declination.fromFixes(fixes) { _, _, _, _ -> null })
        val samples = listOf(sample(0, 10.0, 0.0))
        assertNull(Declination.apply(samples, null).single().azimuthTrueDeg)
        assertEquals(12.0, Declination.apply(samples, 2.0).single().azimuthTrueDeg!!, 1e-9)
    }

    @Test
    fun bearingSpanIsTheCircularRange() {
        assertEquals(0.0, NorthEstimator.bearingSpanDeg(listOf(10.0)), 0.0)
        assertEquals(20.0, NorthEstimator.bearingSpanDeg(listOf(350.0, 10.0, 0.0)), 1e-9)
        assertEquals(270.0, NorthEstimator.bearingSpanDeg(listOf(0.0, 90.0, 180.0, 270.0)), 1e-9)
    }

    @Test
    fun aNarrowRangeOfHeadingsLowersConfidence() {
        val wide = NorthEstimator.estimate(run(0.0, 60, 20.0, sweepDeg = 300.0))!!
        val narrow = NorthEstimator.estimate(run(0.0, 60, 20.0, sweepDeg = 30.0))!!
        assertEquals(20.0, wide.worldYawDeg, 0.5)
        assertTrue("${wide.confidence} vs ${narrow.confidence}", wide.confidence > narrow.confidence * 3)
    }

    @Test
    fun confidenceIsCappedWithoutHighMagnetometerAccuracy() {
        val high = NorthEstimator.estimate(run(0.0, 80, 20.0, accuracy = 3))!!
        val medium = NorthEstimator.estimate(run(0.0, 80, 20.0, accuracy = 2))!!
        assertTrue(high.confidence > 0.9)
        assertTrue(medium.confidence <= 0.6 + 1e-9)
    }

    @Test
    fun fiveHertzSamplesCountOncePerWindow() {
        // 12 s of dense samples: 60 samples but only 6 two-second windows.
        val short = NorthEstimator.estimate(run(0.0, 12, 20.0))!!
        val long = NorthEstimator.estimate(run(0.0, 80, 20.0))!!
        assertTrue(short.confidence < 0.25)
        assertTrue(long.confidence > short.confidence)
    }

    @Test
    fun aWorldFrameJumpAfterTrackingLossIsFlagged() {
        // The first minute has north at 20 degrees; after a 5 s tracking loss the world frame is rotated by 60.
        val samples = run(0.0, 60, 20.0) + run(65.0, 60, 80.0)
        val result = NorthEstimator.estimate(samples)!!
        assertFalse(result.segmentsAgree)
        assertTrue(NorthEstimator.estimate(run(0.0, 60, 20.0) + run(65.0, 60, 21.0))!!.segmentsAgree)
    }

    @Test
    fun disagreeingSegmentsGiveTheBestSupportedSegmentNotALowOverallFigure() {
        // A long segment at offset 20 and a shorter one at 80: the long one is reported, with its own confidence.
        val result = NorthEstimator.estimate(run(0.0, 80, 20.0) + run(85.0, 30, 80.0))!!
        assertFalse(result.segmentsAgree)
        assertTrue(result.fromSegment)
        assertEquals(20.0, result.worldYawDeg, 1.0)
        assertTrue(result.confidence > 0.3)
        assertEquals(0L, result.segmentStartNs)
        assertTrue(result.segmentEndNs!! > 70_000_000_000L)
        // Agreeing segments use everything and are not flagged.
        val agree = NorthEstimator.estimate(run(0.0, 60, 20.0) + run(65.0, 60, 21.0))!!
        assertFalse(agree.fromSegment)
    }

    @Test
    fun segmentsTooShortToEstimateFallBackToTheOverallResult() {
        // Two 3 s segments (15 samples each) beside a 40 s one: all three count as segments, they disagree, and the
        // well supported one is reported with its time span.
        val samples = run(0.0, 40, 20.0) + run(45.0, 3, 80.0) + run(50.0, 3, 140.0)
        val result = NorthEstimator.estimate(samples)!!
        assertFalse(result.segmentsAgree)
        assertTrue(result.fromSegment)
        assertEquals(20.0, result.worldYawDeg, 1.0)
        assertEquals(samples.first().timestampNs, result.segmentStartNs)
        assertEquals(run(0.0, 40, 20.0).last().timestampNs, result.segmentEndNs)
    }

    /** Frames delivered every 33 ms whose timestamps sit [baseNs] behind the boot clock, with latency jitter and spikes. */
    private fun frames(estimator: FrameClockEstimator, count: Int, baseNs: Long, startFrame: Long = 100_000_000_000L): Long {
        var frame = startFrame
        val random = java.util.Random(7)
        repeat(count) { i ->
            frame += 33_000_000L
            // Latency 20 to 70 ms, and a 400 ms stall every 17th frame (a GC pause or a busy GL thread).
            val latency = 20_000_000L + random.nextInt(50_000_000) + if (i % 17 == 0) 400_000_000L else 0L
            estimator.add(frame, frame + baseNs + latency)
        }
        return frame
    }

    @Test
    fun frameClockOnTheBootClockNeedsNoOffsetDespiteJitterAndStalls() {
        val e = FrameClockEstimator()
        frames(e, 10, 0L)
        assertFalse(e.ready)
        frames(e, 100, 0L)
        assertTrue(e.ready)
        assertEquals(0L, e.offsetNs)
        assertEquals(FrameClockEstimator.METHOD_BOOT_CLOCK, e.method)
        assertFalse(e.offsetApplied)
    }

    @Test
    fun frameClockWithAnotherBaseGetsTheOffsetWithinTheLatencySpread() {
        // The torch scans: frame timestamps 5.2 s behind the sensors' clock from the very first frame.
        val e = FrameClockEstimator()
        frames(e, 120, 5_200_000_000L)
        assertTrue(e.ready)
        assertEquals(FrameClockEstimator.METHOD_LOW_PERCENTILE, e.method)
        assertTrue(e.offsetApplied)
        // The true shift is 5.2 s; the estimate is off by the latency left over, under 50 ms.
        assertEquals(5_200_000_000.0, e.offsetNs.toDouble(), 50_000_000.0)
    }

    @Test
    fun frameClockAheadOfTheBootClockGetsANegativeOffset() {
        val e = FrameClockEstimator()
        frames(e, 120, -2_000_000_000L)
        assertEquals(-2_000_000_000.0, e.offsetNs.toDouble(), 50_000_000.0)
    }

    @Test
    fun resetAfterAReconfigureDropsTheOldBaseAtOnce() {
        val e = FrameClockEstimator()
        val last = frames(e, 120, 0L)
        assertTrue(e.ready)
        assertEquals(0L, e.offsetNs)
        e.reset()
        assertFalse(e.ready)
        // The base moved by 3 s with the reconfigure. Without the reset the old frames would outvote the new ones
        // for most of a window; now 25 frames are enough.
        frames(e, 25, 3_000_000_000L, startFrame = last)
        assertTrue(e.ready)
        assertEquals(3_000_000_000.0, e.offsetNs.toDouble(), 50_000_000.0)
        // The scan's offset range still records both bases.
        assertEquals(0L, e.minOffsetNs)
    }

    @Test
    fun withoutAResetAShiftTakesAboutAWindowToWinThePercentile() {
        val e = FrameClockEstimator()
        val last = frames(e, 120, 0L)
        frames(e, 25, 3_000_000_000L, startFrame = last)
        // 25 of the last 60 frames are on the new base: the 10th percentile is still the old one.
        assertEquals(0L, e.offsetNs)
    }

    @Test
    fun highDeliveryLatencyOnTheBootClockIsNotAnOffset() {
        // A busy GL thread: every frame is delivered 150 to 400 ms late, with 700 ms stalls. Still the boot clock.
        val e = FrameClockEstimator()
        var frame = 100_000_000_000L
        val random = java.util.Random(3)
        repeat(150) { i ->
            frame += 33_000_000L
            val latency = 150_000_000L + random.nextInt(250_000_000) + if (i % 11 == 0) 700_000_000L else 0L
            e.add(frame, frame + latency)
        }
        assertTrue(e.ready)
        assertEquals(0L, e.offsetNs)
        assertFalse(e.offsetApplied)
        assertTrue(e.deltaP90Ns > e.deltaP10Ns)
    }

    @Test
    fun theEstimateIsNotRecomputedOnEveryFrame() {
        val e = FrameClockEstimator(refreshEvery = 10)
        val last = frames(e, 60, 0L)
        val before = e.deltaP50Ns
        // Four frames with a very different delta do not move the cached percentiles yet.
        var frame = last
        repeat(4) { frame += 33_000_000L; e.add(frame, frame + 900_000_000L) }
        assertEquals(before, e.deltaP50Ns)
    }

    @Test
    fun frameClockFollowsABaseShiftMidScan() {
        val e = FrameClockEstimator()
        val last = frames(e, 120, 0L)
        assertEquals(0L, e.offsetNs)
        // A reconfigure moves the base by 3 s; once the window has turned over the offset follows.
        frames(e, 120, 3_000_000_000L, startFrame = last)
        assertEquals(3_000_000_000.0, e.offsetNs.toDouble(), 50_000_000.0)
        assertEquals(0L, e.minOffsetNs)
        assertTrue(e.maxOffsetNs > 2_900_000_000L)
    }

    @Test
    fun anEstimatedOffsetPairsFramesWithTheSensorReadingOfTheSameInstant() {
        // A frame stamped 5 s early on the frame clock was captured when the sensors read t; the history holds that reading.
        val e = FrameClockEstimator()
        val last = frames(e, 120, 5_000_000_000L)
        val captureOnSensorClock = last + 5_000_000_000L
        val history = OrientationHistory()
        history.add(OrientationReading(captureOnSensorClock - 10_000_000L, Quaternion(0.0, 0.0, 0.0, 1.0), null))
        history.add(OrientationReading(captureOnSensorClock + 10_000_000L, Quaternion(0.0, 0.0, 0.0, 1.0), null))
        history.add(OrientationReading(last, Quaternion(0.0, 0.0, 0.0, 1.0), null))
        val paired = history.nearest(last + e.offsetNs)
        assertTrue(kotlin.math.abs(paired!!.timestampNs - captureOnSensorClock) <= 30_000_000L)
    }

    @Test
    fun aOneShotClockCalibratorStaysWhereItLanded() {
        val c = ClockCalibrator()
        for (i in 0 until 30) c.add(1_000_000_000L + i * 33_000_000L, 1_000_000_000L + i * 33_000_000L + 40_000_000L)
        c.add(2_000_000_000L, 9_000_000_000L)
        assertEquals(ClockCalibrator.State.COMPARABLE, c.state)
    }

    @Test
    fun boundedSeriesChecksTheGateUnderItsLock() {
        val series = BoundedSeries<Int>(max = 5, minIntervalUnits = 0)
        var on = true
        assertTrue(series.offerIf(1, 1) { on })
        on = false
        assertFalse(series.offerIf(2, 2) { on })
        assertEquals(listOf(1), series.snapshot())
        assertTrue(series.accepts(3))
    }

    private fun reading(ts: Long) = OrientationReading(ts, Quaternion.axisAngle(0.0, 0.0, 1.0, 0.0) * Quaternion.axisAngle(1.0, 0.0, 0.0, Math.toRadians(90.0)), null)

    private fun upright(): FloatArray = FloatArray(16).also { it[0] = 1f; it[5] = 1f; it[10] = 1f; it[15] = 1f }

    @Test
    fun intervalGateLetsTheFirstRealTimestampThroughAndThenSpacesCalls() {
        // A boot-time timestamp of hours: subtracting a Long.MIN_VALUE sentinel would overflow and block the gate for good.
        val gate = IntervalGate(1_000_000_000L)
        val start = 7_200_000_000_000L
        assertTrue(gate.ready(start))
        assertFalse(gate.ready(start + 900_000_000L))
        assertTrue(gate.ready(start + 1_000_000_000L))
        assertFalse(gate.ready(start + 1_500_000_000L))
        assertTrue(gate.ready(start + 2_100_000_000L))
    }

    @Test
    fun aFrameIsPairedWithTheReadingNearestItsCaptureTimeNotTheNewest() {
        val history = OrientationHistory()
        val frame = 10_000_000_000L
        // Readings every 20 ms, the newest 130 ms after the frame (camera pipeline delay).
        for (i in -20..6) history.add(reading(frame + i * 20_000_000L))
        val nearest = history.nearest(frame)!!
        assertEquals(frame, nearest.timestampNs)
        val newest = reading(frame + 130_000_000L)
        // The old pairing (newest reading) would have been dropped by the age check; the nearest one passes.
        assertNull(HeadingMath.sample(frame, upright(), newest, 3, null, 40_000_000L))
        assertNotNull(HeadingMath.sample(frame, upright(), nearest, 3, null, 40_000_000L))
    }

    @Test
    fun historyIsBounded() {
        val history = OrientationHistory(capacity = 4)
        for (i in 0 until 10) history.add(reading(i * 1_000L))
        assertEquals(6_000L, history.nearest(0L)!!.timestampNs)
        assertNull(OrientationHistory().nearest(1L))
    }

    @Test
    fun diagnoseNamesTheRejection() {
        val frame = 5_000_000_000L
        val q = reading(frame)
        assertEquals("no-orientation", HeadingMath.diagnose(frame, upright(), null, 40_000_000L))
        assertEquals("pair-age", HeadingMath.diagnose(frame + 100_000_000L, upright(), q, 40_000_000L))
        assertEquals("ok", HeadingMath.diagnose(frame, upright(), q, 40_000_000L))
        val flat = OrientationReading(frame, Quaternion(0.0, 0.0, 0.0, 1.0), null)
        assertEquals("camera-steep", HeadingMath.diagnose(frame, upright(), flat, 40_000_000L))
        val looksDown = upright().also { it[9] = 1f; it[10] = 0f }
        assertEquals("world-steep", HeadingMath.diagnose(frame, looksDown, q, 40_000_000L))
    }

    @Test
    fun unavailableReasonsExplainWhyThereIsNoNorth() {
        assertEquals("no-heading-samples", NorthEstimator.unavailableReason(emptyList()))
        val lowAccuracy = run(0.0, 10, 0.0, accuracy = 1)
        assertTrue(NorthEstimator.unavailableReason(lowAccuracy).startsWith("magnetometer-accuracy-low"))
        val few = run(0.0, 2, 0.0)
        assertTrue(NorthEstimator.unavailableReason(few).startsWith("too-few-samples"))
    }

    @Test
    fun diagnosticsSummaryIsStable() {
        val d = HeadingDiagnostics()
        d.count("paired"); d.count("pair-age"); d.count("pair-age")
        assertEquals("pair-age=2 paired=1", d.summary())
        d.clear()
        assertEquals("", d.summary())
    }
}
