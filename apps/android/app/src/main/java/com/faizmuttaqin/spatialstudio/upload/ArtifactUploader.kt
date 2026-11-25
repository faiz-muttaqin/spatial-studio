package com.faizmuttaqin.spatialstudio.upload

import com.faizmuttaqin.spatialstudio.scan.ArtifactFile
import com.faizmuttaqin.spatialstudio.scan.FinalizedBundle
import com.faizmuttaqin.spatialstudio.security.OriginAllowlist
import com.faizmuttaqin.spatialstudio.util.Hashing
import java.io.File
import java.io.IOException

/** Sends one artifact. Implementations must not follow redirects. */
fun interface ArtifactTransport {
    fun put(url: String, headers: Map<String, String>, file: File, length: Long): Response

    class Response(val status: Int, val retryAfterSeconds: Long? = null)
}

/** The WebView cookie for an origin, or null. */
fun interface CookieSource {
    fun cookieFor(origin: String): String?
}

class UploadFailedException(message: String) : Exception(message)

/**
 * Uploads a finalized scan bundle with `PUT /api/artifacts/{sha256}` to one
 * trusted origin: every artifact first, the manifest last. The origin comes
 * from the allowlist, never from page input, and the cookie is only sent there.
 */
class ArtifactUploader(
    private val transport: ArtifactTransport,
    private val cookies: CookieSource,
    private val sleep: (Long) -> Unit = { Thread.sleep(it) },
    private val maxAttempts: Int = 8,
) {
    class Progress(val uploaded: Int, val total: Int, val bytesUploaded: Long, val bytesTotal: Long)

    class Result(val manifestUrl: String, val manifestSha256: String)

    fun upload(
        origin: OriginAllowlist.Origin,
        dir: File,
        bundle: FinalizedBundle,
        onProgress: (Progress) -> Unit = {},
    ): Result {
        val files = bundle.artifacts + bundle.manifest
        val bytesTotal = files.sumOf { it.byteLength }
        var bytesUploaded = 0L
        onProgress(Progress(0, files.size, 0, bytesTotal))
        files.forEachIndexed { index, artifact ->
            val file = File(dir, artifact.path)
            verify(file, artifact)
            putWithRetry(origin, file, artifact)
            bytesUploaded += artifact.byteLength
            onProgress(Progress(index + 1, files.size, bytesUploaded, bytesTotal))
        }
        return Result(bundle.manifest.uri, bundle.manifest.sha256)
    }

    private fun verify(file: File, artifact: ArtifactFile) {
        if (!file.isFile || file.length() != artifact.byteLength || Hashing.sha256Hex(file) != artifact.sha256) {
            throw UploadFailedException("Scan file ${artifact.path} changed on the device; discard and rescan")
        }
    }

    private fun putWithRetry(origin: OriginAllowlist.Origin, file: File, artifact: ArtifactFile) {
        val url = "$origin/api/artifacts/${artifact.sha256}"
        val headers = LinkedHashMap<String, String>()
        headers["Origin"] = origin.toString()
        headers["Content-Type"] = artifact.mediaType
        cookies.cookieFor(origin.toString())?.takeIf { it.isNotBlank() }?.let { headers["Cookie"] = it }

        var attempt = 0
        while (true) {
            attempt++
            val response = try {
                transport.put(url, headers, file, artifact.byteLength)
            } catch (e: IOException) {
                null
            }
            val status = response?.status ?: -1
            if (status in 200..299) return
            val retryable = status == -1 || status == 408 || status == 429 || status in 500..599
            if (!retryable) throw UploadFailedException(describe(status, origin))
            if (attempt >= maxAttempts) {
                throw UploadFailedException(
                    if (status == -1) "Network error uploading to $origin" else describe(status, origin),
                )
            }
            sleep(retryDelayMs(status, response?.retryAfterSeconds, attempt))
        }
    }

    companion object {
        fun retryDelayMs(status: Int, retryAfterSeconds: Long?, attempt: Int): Long {
            if (status == 429 && retryAfterSeconds != null) return retryAfterSeconds.coerceIn(1, 60) * 1000
            val backoff = 1000L shl (attempt - 1).coerceIn(0, 5)
            return backoff.coerceAtMost(30_000)
        }

        fun describe(status: Int, origin: OriginAllowlist.Origin): String = when (status) {
            401 -> "Not signed in to $origin. Sign in to the studio in this app, then upload again."
            403 -> "The studio at $origin refused the upload (HTTP 403)."
            400 -> "The studio at $origin rejected an artifact (HTTP 400)."
            413 -> "An artifact is larger than the studio at $origin accepts (HTTP 413)."
            429 -> "The studio at $origin is rate limiting uploads. Try again in a minute."
            503 -> "The studio at $origin is not configured to accept uploads (HTTP 503)."
            else -> "Upload to $origin failed (HTTP $status)."
        }
    }
}
