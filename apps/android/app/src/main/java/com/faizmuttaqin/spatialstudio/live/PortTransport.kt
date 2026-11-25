package com.faizmuttaqin.spatialstudio.live

import android.annotation.SuppressLint
import android.os.Handler
import android.util.Log
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebMessagePortCompat
import java.util.concurrent.atomic.AtomicInteger

/**
 * Transport (a): a `WebMessagePort` handed to the page with `postWebMessage`, scoped to its origin by the
 * target origin of that call. The page receives ArrayBuffers; nothing listens on the network. Posting runs
 * on the main thread, at most [MAX_IN_FLIGHT] frames waiting there.
 */
class PortTransport(
    private val port: WebMessagePortCompat,
    private val main: Handler,
) : LiveTransport {
    override val name = "port"

    @Volatile private var closed = false
    private val inFlight = AtomicInteger()

    // The caller checked WEB_MESSAGE_PORT_POST_MESSAGE and WEB_MESSAGE_ARRAY_BUFFER before creating the channel.
    @SuppressLint("RequiresFeature")
    override fun send(frame: ByteArray): Boolean {
        if (closed || inFlight.incrementAndGet() > MAX_IN_FLIGHT) {
            inFlight.decrementAndGet()
            return false
        }
        main.post {
            try {
                if (!closed) port.postMessage(WebMessageCompat(frame))
            } catch (e: Exception) {
                Log.w(TAG, "Could not post a live frame", e)
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
