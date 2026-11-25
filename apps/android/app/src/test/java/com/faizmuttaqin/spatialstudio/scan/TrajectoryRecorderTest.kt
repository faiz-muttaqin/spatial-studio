package com.faizmuttaqin.spatialstudio.scan

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TrajectoryRecorderTest {
    private val ms = 1_000_000L

    @Test
    fun samplesAtAboutTenHertz() {
        val recorder = TrajectoryRecorder()
        // 30 fps for one second.
        for (i in 0 until 30) recorder.onFrame(i * 33 * ms, true, Matrices.pose(x = i * 0.01f))
        assertEquals(10, recorder.samples.size)
        assertEquals(listOf(0), recorder.samples.map { it.segment }.distinct())
    }

    @Test
    fun trackingLossStartsANewSegment() {
        val recorder = TrajectoryRecorder()
        recorder.onFrame(0, true, Matrices.pose())
        recorder.onFrame(100 * ms, true, Matrices.pose(x = 0.1f))
        recorder.onFrame(150 * ms, false, Matrices.pose())
        recorder.onFrame(180 * ms, false, Matrices.pose())
        // Re-acquired: sampled at once, in segment 1.
        recorder.onFrame(190 * ms, true, Matrices.pose(x = 0.3f))
        recorder.onFrame(300 * ms, true, Matrices.pose(x = 0.4f))
        assertEquals(listOf(0, 0, 1, 1), recorder.samples.map { it.segment })
        assertEquals(1, recorder.trackingLossCount)
        assertEquals(190 * ms, recorder.samples[2].timestampNs)
    }

    @Test
    fun framesBeforeFirstTrackingDoNotCountAsLoss() {
        val recorder = TrajectoryRecorder()
        recorder.onFrame(0, false, Matrices.pose())
        recorder.onFrame(50 * ms, true, Matrices.pose())
        assertEquals(0, recorder.trackingLossCount)
        assertEquals(0, recorder.samples.single().segment)
    }

    @Test
    fun decimatesInsteadOfGrowingWithoutBound() {
        val recorder = TrajectoryRecorder(maxSamples = 100)
        // 60 s at 30 fps would be about 600 samples at 10 Hz.
        for (i in 0 until 1800) recorder.onFrame(i * 33 * ms, true, Matrices.pose(x = i * 0.001f))
        assertTrue(recorder.decimated)
        assertTrue(recorder.samples.size <= 100)
        // The whole scan is still covered, at a lower rate.
        assertEquals(0L, recorder.samples.first().timestampNs)
        assertTrue(recorder.samples.last().timestampNs > 55_000 * ms)
        assertEquals(recorder.samples.sortedBy { it.timestampNs }, recorder.samples)
    }

    @Test
    fun decimationKeepsTheFirstSampleOfEachSegment() {
        val recorder = TrajectoryRecorder(maxSamples = 4)
        recorder.onFrame(0, true, Matrices.pose())
        recorder.onFrame(100 * ms, true, Matrices.pose())
        recorder.onFrame(150 * ms, false, Matrices.pose())
        recorder.onFrame(200 * ms, true, Matrices.pose())
        recorder.onFrame(300 * ms, true, Matrices.pose())
        recorder.onFrame(400 * ms, true, Matrices.pose())
        assertTrue(recorder.decimated)
        assertEquals(listOf(0, 1), recorder.samples.map { it.segment }.distinct())
        assertEquals(200 * ms, recorder.samples.first { it.segment == 1 }.timestampNs)
    }

    @Test
    fun storesACopyOfThePose() {
        val recorder = TrajectoryRecorder()
        val pose = Matrices.pose(x = 1f)
        recorder.onFrame(0, true, pose)
        pose[12] = 99f
        assertEquals(1f, recorder.samples.single().transform[12])
    }
}
