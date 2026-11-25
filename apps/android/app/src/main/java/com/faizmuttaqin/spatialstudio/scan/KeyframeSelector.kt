package com.faizmuttaqin.spatialstudio.scan

/**
 * Decides when a tracked frame becomes a keyframe: the first tracked frame, then
 * whenever the camera has moved [spacingM] metres or turned [angleDeg] degrees
 * since the last accepted keyframe.
 */
class KeyframeSelector(
    private val spacingM: Double = ScanOptions.DEFAULT_SPACING_M,
    private val angleDeg: Double = ScanOptions.DEFAULT_ANGLE_DEG,
    val maxKeyframes: Int = ScanOptions.MAX_KEYFRAMES,
    private val minIntervalNs: Long = 250_000_000L,
) {
    var count: Int = 0
        private set
    private var lastPose: FloatArray? = null
    private var lastTimestampNs: Long = Long.MIN_VALUE

    val limitReached: Boolean get() = count >= maxKeyframes

    fun shouldCapture(timestampNs: Long, tracking: Boolean, pose: FloatArray): Boolean {
        if (!tracking || limitReached || !PoseMath.isFinite(pose)) return false
        val last = lastPose ?: return true
        if (timestampNs - lastTimestampNs < minIntervalNs) return false
        return PoseMath.translationDistance(last, pose) >= spacingM ||
            PoseMath.rotationAngleDeg(last, pose) >= angleDeg
    }

    /** Records a keyframe that was actually stored. */
    fun accept(timestampNs: Long, pose: FloatArray) {
        lastPose = pose.copyOf()
        lastTimestampNs = timestampNs
        count++
    }
}
