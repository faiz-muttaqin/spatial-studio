package com.faizmuttaqin.spatialstudio.live

import java.util.concurrent.atomic.AtomicLong

/** A way to deliver one frame to the preview page. Implementations must never block the caller. */
interface LiveTransport {
    val name: String

    /** Queues [frame]; false when it was dropped (closed, or the page is not keeping up). */
    fun send(frame: ByteArray): Boolean

    /** Idempotent. After it returns nothing more is delivered and no port or socket stays open. */
    fun close()
}

/** Minimum spacing per frame kind, and a byte budget, so the stream stays a light preview. */
class LiveRates(
    private val intervalsNs: Map<LiveFrameType, Long> = DEFAULT_INTERVALS_NS,
    private val bytesPerSecond: Long = DEFAULT_BYTES_PER_SECOND,
    private val burstBytes: Long = DEFAULT_BURST_BYTES,
) {
    private val last = HashMap<LiveFrameType, Long>()
    private var tokens = burstBytes.toDouble()
    private var tokensAtNs = 0L

    /** True when a frame of [type] may be built at [timestampNs]. Does not spend budget. */
    @Synchronized
    fun due(type: LiveFrameType, timestampNs: Long): Boolean {
        val previous = last[type]
        return previous == null || timestampNs - previous >= (intervalsNs[type] ?: 0L)
    }

    /** Takes [bytes] of budget at [timestampNs] and marks [type] as sent; false (and nothing taken) when over budget. */
    @Synchronized
    fun spend(type: LiveFrameType, timestampNs: Long, bytes: Int): Boolean {
        if (tokensAtNs != 0L && timestampNs > tokensAtNs) {
            tokens = minOf(burstBytes.toDouble(), tokens + (timestampNs - tokensAtNs) / 1e9 * bytesPerSecond)
        }
        tokensAtNs = timestampNs
        if (tokens < bytes) return false
        tokens -= bytes
        last[type] = timestampNs
        return true
    }

    companion object {
        /** Depth 5 Hz, pose 10 Hz, coverage 2 Hz, planes 1 Hz. */
        val DEFAULT_INTERVALS_NS = mapOf(
            LiveFrameType.DEPTH to 200_000_000L,
            LiveFrameType.POSE to 100_000_000L,
            LiveFrameType.COVERAGE to 500_000_000L,
            LiveFrameType.PLANES to 1_000_000_000L,
        )
        const val DEFAULT_BYTES_PER_SECOND = 400_000L
        const val DEFAULT_BURST_BYTES = 150_000L
    }
}

/**
 * Preview feed from the scan screen. The recorder asks [wants] before it builds a frame (so an idle stream
 * costs one volatile read) and hands the result to [submit]. The stream has no state of its own that the
 * recording depends on: if it is closed or slow, frames are dropped and the scan carries on.
 */
class LiveStream(private val rates: LiveRates = LiveRates()) {
    @Volatile
    private var transport: LiveTransport? = null
    private val seq = AtomicLong()
    private val sent = AtomicLong()
    private val dropped = AtomicLong()

    val framesSent: Long get() = sent.get()
    val framesDropped: Long get() = dropped.get()

    /** Replaces (and closes) any earlier transport. */
    fun attach(next: LiveTransport) {
        val old = transport
        transport = next
        if (old !== next) old?.close()
    }

    /** Closes the transport. Called on pause, finish and cancel. */
    fun detach() {
        val old = transport
        transport = null
        old?.close()
    }

    val isOpen: Boolean get() = transport != null

    fun nextSeq(): Long = seq.getAndIncrement()

    fun wants(type: LiveFrameType, timestampNs: Long): Boolean = transport != null && rates.due(type, timestampNs)

    /** Sends a frame built after [wants]. Returns false when it was dropped. */
    fun submit(type: LiveFrameType, timestampNs: Long, frame: ByteArray): Boolean {
        val t = transport ?: return false
        if (frame.size > LiveFrames.MAX_FRAME_BYTES || !rates.spend(type, timestampNs, frame.size) || !t.send(frame)) {
            dropped.incrementAndGet()
            return false
        }
        sent.incrementAndGet()
        return true
    }
}
