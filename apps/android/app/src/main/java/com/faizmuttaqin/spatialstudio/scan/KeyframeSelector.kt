package com.faizmuttaqin.spatialstudio.scan

/**
 * Decides when a tracked frame becomes a keyframe: the first tracked frame, then
 * whenever the camera has moved [spacingM] metres or turned [angleDeg] degrees
 * since the last keyframe attempt.
 *
 * A keyframe counts against [maxKeyframes] only once it is stored: [reserve]
 * holds a slot while it is encoded, then [commit] or [release] settles it.
 * Called from the GL thread and the encoder thread.
 */
class KeyframeSelector(
    private val spacingM: Double = ScanOptions.DEFAULT_SPACING_M,
    private val angleDeg: Double = ScanOptions.DEFAULT_ANGLE_DEG,
    val maxKeyframes: Int = ScanOptions.MAX_KEYFRAMES,
    private val minIntervalNs: Long = 250_000_000L,
) {
    /** Stored keyframes. */
    @get:Synchronized
    var count: Int = 0
        private set
    private var reserved = 0
    private var attempts = 0
    private var lastPose: FloatArray? = null
    private var lastTimestampNs: Long = Long.MIN_VALUE

    @get:Synchronized
    val limitReached: Boolean get() = count + reserved >= maxKeyframes

    @Synchronized
    fun shouldCapture(timestampNs: Long, tracking: Boolean, pose: FloatArray): Boolean {
        if (!tracking || limitReached || !PoseMath.isFinite(pose)) return false
        val last = lastPose ?: return true
        if (timestampNs - lastTimestampNs < minIntervalNs) return false
        return PoseMath.translationDistance(last, pose) >= spacingM ||
            PoseMath.rotationAngleDeg(last, pose) >= angleDeg
    }

    /**
     * Starts a keyframe at this pose and returns its 1-based attempt number (for
     * ids). The movement gate restarts here whether or not the encode succeeds.
     */
    @Synchronized
    fun reserve(timestampNs: Long, pose: FloatArray): Int {
        lastPose = pose.copyOf()
        lastTimestampNs = timestampNs
        reserved++
        return ++attempts
    }

    /** The reserved keyframe was stored. */
    @Synchronized
    fun commit() {
        if (reserved > 0) reserved--
        count++
    }

    /** The reserved keyframe could not be stored; its slot is free again. */
    @Synchronized
    fun release() {
        if (reserved > 0) reserved--
    }
}
