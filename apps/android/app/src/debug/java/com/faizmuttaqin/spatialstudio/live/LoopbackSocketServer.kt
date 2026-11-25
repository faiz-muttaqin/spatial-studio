package com.faizmuttaqin.spatialstudio.live

import android.util.Log
import java.io.IOException
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.security.SecureRandom
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * Spike transport (b): a WebSocket server on 127.0.0.1 only, on a random port, for one client with a
 * per-session token and an exact Origin match. Binary frames only. It is off by default: it exists only
 * between [start] and [close], and the scan screen closes it on pause, finish and cancel.
 */
class LoopbackSocketServer(private val allowedOrigins: Set<String>) : LiveTransport {
    class Endpoint(val port: Int, val token: String) {
        /** What the page connects to. */
        val url: String get() = "ws://127.0.0.1:$port${WebSocketFraming.PATH}?t=$token"
    }

    override val name = "ws"

    @Volatile private var closed = false
    private var server: ServerSocket? = null
    @Volatile private var client: Socket? = null
    private val outbox = ArrayBlockingQueue<ByteArray>(MAX_QUEUED_FRAMES)

    /** The writer thread, the pong reply and the close frame share one socket: one writer at a time. */
    private val writeLock = Any()

    fun start(): Endpoint {
        val token = ByteArray(16).also(SecureRandom()::nextBytes).joinToString("") { "%02x".format(it) }
        val socket = ServerSocket(0, 1, InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1)))
        server = socket
        val endpoint = Endpoint(socket.localPort, token)
        Thread({ acceptLoop(socket, endpoint) }, "live-ws-accept").apply { isDaemon = true }.start()
        return endpoint
    }

    private fun acceptLoop(socket: ServerSocket, endpoint: Endpoint) {
        while (!closed) {
            val connection = try {
                socket.accept()
            } catch (e: IOException) {
                return
            }
            // One client at a time: a second connection waits in the backlog until the first ends.
            serve(connection, endpoint)
        }
    }

    private fun serve(connection: Socket, endpoint: Endpoint) {
        try {
            connection.soTimeout = HANDSHAKE_TIMEOUT_MS
            connection.tcpNoDelay = true
            val head = WebSocketFraming.readHead(connection.getInputStream())
            val verdict = if (head == null) {
                WebSocketFraming.Handshake.Rejected(400, "bad request")
            } else {
                WebSocketFraming.handshake(head, endpoint.port, endpoint.token, allowedOrigins)
            }
            val out = connection.getOutputStream()
            if (verdict is WebSocketFraming.Handshake.Rejected) {
                Log.i(TAG, "Rejected a loopback connection: ${verdict.status}")
                out.write(WebSocketFraming.responseError(verdict.status, verdict.reason))
                return
            }
            out.write(WebSocketFraming.responseOk((verdict as WebSocketFraming.Handshake.Ok).accept))
            out.flush()
            outbox.clear()
            client = connection
            connection.soTimeout = 0
            val writer = Thread({ writeLoop(connection) }, "live-ws-write").apply { isDaemon = true }
            writer.start()
            readLoop(connection)
            writer.interrupt()
        } catch (e: IOException) {
            // The page went away or the stream ended.
        } finally {
            if (client === connection) client = null
            runCatching { connection.close() }
        }
    }

    private fun writeLoop(connection: Socket) {
        try {
            val out = connection.getOutputStream()
            while (!closed && !connection.isClosed) {
                val frame = outbox.poll(200, TimeUnit.MILLISECONDS) ?: continue
                synchronized(writeLock) {
                    out.write(WebSocketFraming.frame(WebSocketFraming.OP_BINARY, frame))
                    out.flush()
                }
            }
        } catch (e: IOException) {
            runCatching { connection.close() }
        } catch (e: InterruptedException) {
            // Closing.
        }
    }

    private fun readLoop(connection: Socket) {
        val input = connection.getInputStream()
        val out = connection.getOutputStream()
        while (!closed) {
            val frame = WebSocketFraming.readClientFrame(input) ?: run {
                synchronized(writeLock) { out.write(WebSocketFraming.closeFrame(1008)) }
                return
            }
            when (frame.opcode) {
                WebSocketFraming.OP_PING -> synchronized(writeLock) { out.write(WebSocketFraming.frame(WebSocketFraming.OP_PONG, frame.payload)) }
                WebSocketFraming.OP_CLOSE -> return
            }
        }
    }

    override fun send(frame: ByteArray): Boolean {
        if (closed || client == null) return false
        // Full queue: the page is behind; drop this frame (a preview never queues up).
        return outbox.offer(frame)
    }

    override fun close() {
        if (closed) return
        closed = true
        outbox.clear()
        runCatching { server?.close() }
        // Callers run on the main thread; a write to a stuck peer must not block it.
        val peer = client
        if (peer != null) {
            Thread({
                runCatching { synchronized(writeLock) { peer.soTimeout = 0; peer.getOutputStream().write(WebSocketFraming.closeFrame(1001)) } }
                runCatching { peer.close() }
            }, "live-ws-close").apply { isDaemon = true }.start()
        }
    }

    private companion object {
        const val TAG = "SpatialStudioLive"
        const val MAX_QUEUED_FRAMES = 4
        const val HANDSHAKE_TIMEOUT_MS = 3_000
    }
}
