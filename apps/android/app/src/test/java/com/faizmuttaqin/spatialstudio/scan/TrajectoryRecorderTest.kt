package com.faizmuttaqin.spatialstudio.scan

import org.junit.Assert.assertEquals
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
    fun storesACopyOfThePose() {
        val recorder = TrajectoryRecorder()
        val pose = Matrices.pose(x = 1f)
        recorder.onFrame(0, true, pose)
        pose[12] = 99f
        assertEquals(1f, recorder.samples.single().transform[12])
    }
}
