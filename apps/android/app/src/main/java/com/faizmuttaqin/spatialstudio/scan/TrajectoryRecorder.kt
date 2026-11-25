package com.faizmuttaqin.spatialstudio.scan

class TrajectorySample(val segment: Int, val timestampNs: Long, val transform: FloatArray)

/**
 * Samples the camera pose at about [intervalNs]. Losing tracking ends the
 * current segment; the next tracked frame starts a new one and is sampled at once.
 *
 * The trajectory is written inline in the manifest, so it is bounded: past
 * [maxSamples] every other sample is dropped (the first of each segment is
 * kept) and the interval doubles, which keeps the whole scan at a lower rate.
 */
class TrajectoryRecorder(
    private var intervalNs: Long = 100_000_000L,
    private val maxSamples: Int = 20_000,
) {
    private var _samples = ArrayList<TrajectorySample>()
    val samples: List<TrajectorySample> get() = _samples

    var trackingLossCount: Int = 0
        private set

    /** True once the trajectory has been thinned to stay within [maxSamples]. */
    var decimated: Boolean = false
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
            if (_samples.size > maxSamples) decimate()
        }
    }

    private fun decimate() {
        val kept = ArrayList<TrajectorySample>(_samples.size / 2 + 1)
        var previousSegment = -1
        _samples.forEachIndexed { index, sample ->
            if (index % 2 == 0 || sample.segment != previousSegment) kept.add(sample)
            previousSegment = sample.segment
        }
        _samples = kept
        intervalNs *= 2
        decimated = true
    }
}
