package com.faizmuttaqin.spatialstudio.live

import android.annotation.SuppressLint
import android.os.Handler
import android.util.Log
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebMessagePortCompat
import java.util.concurrent.atomic.AtomicInteger

/**
 * How far the sender may run ahead of the page. The page's worker acknowledges the number of frames it has
 * processed (`ack:<count>`), so a worker busy with a long pass stops the flow instead of letting frames
 * pile up inside the WebView. Depth goes first: past [softLimit] unacknowledged frames only depth is dropped,
 * past [hardLimit] everything is.
 */
class AckWindow(private val softLimit: Int = 4, private val hardLimit: Int = 8) {
    private var sent = 0L
    private var acked = 0L

    /** True (and counted as sent) when a frame of [type] may go out now. */
    @Synchronized
    fun admit(type: LiveFrameType): Boolean {
        val limit = if (type == LiveFrameType.DEPTH) softLimit else hardLimit
        if (sent - acked >= limit) return false
        sent++
        return true
    }

    /** [processed] is the page's running count; counts outside what was sent are ignored. */
    @Synchronized
    fun ack(processed: Long) {
        if (processed in acked..sent) acked = processed
    }

    @get:Synchronized
    val unacked: Long get() = sent - acked

    companion object {
        private const val PREFIX = "ack:"

        /** The count in an `ack:<n>` message, or null for anything else. */
        fun parse(message: String?): Long? {
            if (message == null || message.length > 24 || !message.startsWith(PREFIX)) return null
            return message.substring(PREFIX.length).takeIf { it.isNotEmpty() && it.all(Char::isDigit) }?.toLongOrNull()
        }
    }
}

/**
 * Transport (a): a `WebMessagePort` handed to the page with `postWebMessage`, scoped to its origin by the
 * target origin of that call. The page receives ArrayBuffers; nothing listens on the network. Posting runs
 * on the main thread, at most [MAX_IN_FLIGHT] frames waiting there, and the [AckWindow] keeps the page's
 * own queue short.
 */
class PortTransport(
    private val port: WebMessagePortCompat,
    private val main: Handler,
    private val window: AckWindow = AckWindow(),
) : LiveTransport {
    override val name = "port"

    @Volatile private var closed = false
    private val inFlight = AtomicInteger()

    init {
        listenForAcks()
    }

    // The caller checked WEB_MESSAGE_PORT_SET_MESSAGE_CALLBACK before creating the channel.
    @SuppressLint("RequiresFeature")
    private fun listenForAcks() {
        port.setWebMessageCallback(
            main,
            object : WebMessagePortCompat.WebMessageCallbackCompat() {
                override fun onMessage(port: WebMessagePortCompat, message: WebMessageCompat?) {
                    if (message?.type == WebMessageCompat.TYPE_STRING) AckWindow.parse(message.data)?.let(window::ack)
                }
            },
        )
    }

    // The caller checked WEB_MESSAGE_PORT_POST_MESSAGE and WEB_MESSAGE_ARRAY_BUFFER before creating the channel.
    @SuppressLint("RequiresFeature")
    override fun send(frame: ByteArray): Boolean {
        val type = if (frame.size > 4) LiveFrameType.of(frame[4].toInt() and 0xFF) else null
        if (closed || type == null) return false
        if (inFlight.incrementAndGet() > MAX_IN_FLIGHT || !window.admit(type)) {
            inFlight.decrementAndGet()
            return false
        }
        main.post {
            try {
                if (!closed) port.postMessage(WebMessageCompat(frame))
            } catch (e: Exception) {
                Log.w(TAG, "Could not post a live frame: ${e.javaClass.simpleName}")
            } finally {
                inFlight.decrementAndGet()
            }
        }
        return true
    }

    @SuppressLint("RequiresFeature")
    override fun close() {
        if (closed) return
        closed = true
        // Closing posts to the main thread too, so it runs after any frame already queued.
        main.post { runCatching { port.close() } }
    }

    private companion object {
        const val TAG = "SpatialStudioLive"
        const val MAX_IN_FLIGHT = 4
    }
}
