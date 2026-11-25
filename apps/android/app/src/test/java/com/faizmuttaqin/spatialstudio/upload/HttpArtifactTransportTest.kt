package com.faizmuttaqin.spatialstudio.upload

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.IOException
import java.net.ServerSocket
import java.util.concurrent.atomic.AtomicBoolean

class HttpArtifactTransportTest {
    @get:Rule
    val tmp = TemporaryFolder()

    /** A server that accepts and reads the request but never answers. */
    private fun silentServer(): Pair<ServerSocket, Thread> {
        val server = ServerSocket(0)
        val thread = Thread {
            runCatching {
                server.accept().use { socket ->
                    val buffer = ByteArray(4096)
                    while (socket.getInputStream().read(buffer) >= 0) Unit
                }
            }
        }.also { it.isDaemon = true; it.start() }
        return server to thread
    }

    private fun body() = tmp.newFile().also { it.writeBytes(ByteArray(2000) { 1 }) }

    @Test
    fun aStalledRequestIsCutInsteadOfHoldingItsThread() {
        val (server, _) = silentServer()
        server.use {
            val transport = HttpArtifactTransport(stallMs = 200)
            val started = System.nanoTime()
            assertThrows(IOException::class.java) {
                transport.put("http://127.0.0.1:${server.localPort}/x", emptyMap(), body(), 2000, PutControl())
            }
            assertTrue((System.nanoTime() - started) / 1_000_000 < 15_000)
        }
    }

    @Test
    fun aCancelledRequestIsCut() {
        val (server, _) = silentServer()
        server.use {
            val cancelled = AtomicBoolean(false)
            val transport = HttpArtifactTransport()
            Thread { Thread.sleep(300); cancelled.set(true) }.start()
            val started = System.nanoTime()
            assertThrows(IOException::class.java) {
                transport.put("http://127.0.0.1:${server.localPort}/x", emptyMap(), body(), 2000, PutControl(isCancelled = { cancelled.get() }))
            }
            assertTrue((System.nanoTime() - started) / 1_000_000 < 15_000)
        }
    }

    @Test
    fun reportsActivityWhileSendingAndReturnsTheStatus() {
        val server = ServerSocket(0)
        val thread = Thread {
            server.accept().use { socket ->
                val input = socket.getInputStream()
                var seen = 0
                val buffer = ByteArray(8192)
                // Read until the full 2000-byte body and its headers have arrived.
                while (seen < 2000) { val n = input.read(buffer); if (n < 0) break; seen += n }
                socket.getOutputStream().write("HTTP/1.1 201 Created\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray())
                socket.getOutputStream().flush()
            }
        }.also { it.isDaemon = true; it.start() }
        server.use {
            var activity = 0
            val response = HttpArtifactTransport().put(
                "http://127.0.0.1:${server.localPort}/x", emptyMap(), body(), 2000, PutControl(onActivity = { activity++ }),
            )
            assertEquals(201, response.status)
            assertTrue(activity >= 1)
        }
        thread.join(2000)
    }
}
