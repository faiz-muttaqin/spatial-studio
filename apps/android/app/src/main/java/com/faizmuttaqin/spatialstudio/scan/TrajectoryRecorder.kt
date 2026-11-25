package com.faizmuttaqin.spatialstudio.scan

class TrajectorySample(val segment: Int, val timestampNs: Long, val transform: FloatArray)

/**
 * Samples the camera pose at about [intervalNs]. Losing tracking ends the
 * current segment; the next tracked frame starts a new one and is sampled at once.
 */
class TrajectoryRecorder(private val intervalNs: Long = 100_000_000L) {
    private val _samples = ArrayList<TrajectorySample>()
    val samples: List<TrajectorySample> get() = _samples

    var trackingLossCount: Int = 0
        private set
    private var segment = 0
    private var tracking = false
    private var trackedBefore = false
    private var lastSampleNs = Long.MIN_VALUE

    fun onFrame(timestampNs: Long, isTracking: Boolean, pose: FloatArray) {
        if (!isTracking) {
            if (tracking) trackingLossCount++
            tracking = false
            return
        }
        if (!tracking && trackedBefore) {
            segment++
            lastSampleNs = Long.MIN_VALUE
        }
        tracking = true
        trackedBefore = true
        if (!PoseMath.isFinite(pose)) return
        // 10% tolerance so 30 fps frames (33 ms apart) still give about 10 samples per second.
        if (lastSampleNs == Long.MIN_VALUE || timestampNs - lastSampleNs >= intervalNs * 9 / 10) {
            _samples.add(TrajectorySample(segment, timestampNs, pose.copyOf()))
            lastSampleNs = timestampNs
        }
    }
}
