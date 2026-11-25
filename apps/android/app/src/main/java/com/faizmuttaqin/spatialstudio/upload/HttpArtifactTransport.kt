package com.faizmuttaqin.spatialstudio.upload

import java.io.File
import java.net.HttpURLConnection
import java.net.URI

/** `HttpURLConnection` PUT. Redirects are not followed, so the cookie never leaves the origin. */
class HttpArtifactTransport(
    private val connectTimeoutMs: Int = 15_000,
    private val readTimeoutMs: Int = 60_000,
) : ArtifactTransport {

    override fun put(url: String, headers: Map<String, String>, file: File, length: Long): ArtifactTransport.Response {
        val connection = URI(url).toURL().openConnection() as HttpURLConnection
        try {
            connection.requestMethod = "PUT"
            connection.instanceFollowRedirects = false
            connection.useCaches = false
            connection.doOutput = true
            connection.connectTimeout = connectTimeoutMs
            connection.readTimeout = readTimeoutMs
            connection.setFixedLengthStreamingMode(length)
            headers.forEach { (name, value) -> connection.setRequestProperty(name, value) }
            connection.outputStream.use { out -> file.inputStream().use { it.copyTo(out, 64 * 1024) } }
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
        } finally {
            connection.disconnect()
        }
    }
}
