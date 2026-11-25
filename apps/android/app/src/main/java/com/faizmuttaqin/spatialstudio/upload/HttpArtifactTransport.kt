package com.faizmuttaqin.spatialstudio.upload

import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/**
 * `HttpURLConnection` PUT. Redirects are not followed, so the cookie never leaves the origin.
 *
 * `HttpURLConnection` has no write timeout, so a watchdog disconnects a PUT that is cancelled, has
 * moved no bytes for [stallMs], or has run longer than [maxPutMs]; the blocked call then fails with an
 * [IOException] instead of holding its thread (and the upload lock) forever.
 */
class HttpArtifactTransport(
    private val connectTimeoutMs: Int = 15_000,
    private val readTimeoutMs: Int = 60_000,
    private val stallMs: Long = STALL_MS,
    private val maxPutMs: Long = MAX_PUT_MS,
    private val nowMs: () -> Long = { System.nanoTime() / 1_000_000 },
) : ArtifactTransport {

    override fun put(url: String, headers: Map<String, String>, file: File, length: Long): ArtifactTransport.Response =
        put(url, headers, file, length, PutControl())

    override fun put(url: String, headers: Map<String, String>, file: File, length: Long, control: PutControl): ArtifactTransport.Response {
        val connection = URI(url).toURL().openConnection() as HttpURLConnection
        val startedAt = nowMs()
        val lastActivityAt = AtomicLong(startedAt)
        val stopped = AtomicBoolean(false)
        val watchdog = WATCHDOGS.scheduleWithFixedDelay({
            val now = nowMs()
            if (control.isCancelled() || now - lastActivityAt.get() > stallMs || now - startedAt > maxPutMs) {
                stopped.set(true)
                runCatching { connection.disconnect() }
            }
        }, 1, 1, TimeUnit.SECONDS)
        try {
            connection.requestMethod = "PUT"
            connection.instanceFollowRedirects = false
            connection.useCaches = false
            connection.doOutput = true
            connection.connectTimeout = connectTimeoutMs
            connection.readTimeout = readTimeoutMs
            connection.setFixedLengthStreamingMode(length)
            headers.forEach { (name, value) -> connection.setRequestProperty(name, value) }
            connection.outputStream.use { out ->
                file.inputStream().use { input ->
                    val buffer = ByteArray(CHUNK)
                    while (true) {
                        val n = input.read(buffer)
                        if (n < 0) break
                        out.write(buffer, 0, n)
                        lastActivityAt.set(nowMs())
                        control.onActivity()
                    }
                }
            }
            // The body is sent; waiting for the response counts from here.
            lastActivityAt.set(nowMs())
            control.onActivity()
            val status = connection.responseCode
            val retryAfter = connection.getHeaderField("Retry-After")?.trim()?.toLongOrNull()
            // Drain a little of the body so the connection can be reused; its content is not logged.
            runCatching {
                (if (status >= 400) connection.errorStream else connection.inputStream)?.use { body ->
                    val buffer = ByteArray(4096)
                    body.read(buffer)
                }
            }
            return ArtifactTransport.Response(status, retryAfter)
        } catch (e: IOException) {
            throw if (stopped.get()) IOException("Upload request stopped by the watchdog", e) else e
        } finally {
            watchdog.cancel(false)
            connection.disconnect()
        }
    }

    private companion object {
        const val CHUNK = 64 * 1024
        /** No bytes moved for this long: the connection is cut. The read timeout covers the response. */
        const val STALL_MS = 45_000L
        const val MAX_PUT_MS = 10L * 60 * 1000
        val WATCHDOGS = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "upload-watchdog").apply { isDaemon = true } }
    }
}
