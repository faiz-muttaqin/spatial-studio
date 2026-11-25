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
 *
 * Artifacts already confirmed for this origin (see [UploadLog]) are skipped, so
 * a retry resumes. Requests start at most every [minIntervalMs], below the
 * studio's per-client limit of 120 requests a minute, and a 429 waits for
 * Retry-After.
 */
class ArtifactUploader(
    private val transport: ArtifactTransport,
    private val cookies: CookieSource,
    private val sleep: (Long) -> Unit = { Thread.sleep(it) },
    private val now: () -> Long = { System.nanoTime() / 1_000_000 },
    private val maxAttempts: Int = 8,
    private val minIntervalMs: Long = DEFAULT_MIN_INTERVAL_MS,
) {
    class Progress(val uploaded: Int, val total: Int, val bytesUploaded: Long, val bytesTotal: Long)

    class Result(val manifestUrl: String, val manifestSha256: String, val sent: Int, val skipped: Int)

    private var lastRequestAt = Long.MIN_VALUE

    fun upload(
        origin: OriginAllowlist.Origin,
        dir: File,
        bundle: FinalizedBundle,
        log: UploadLog? = null,
        onProgress: (Progress) -> Unit = {},
    ): Result {
        // Identical content is one artifact on the server: send each hash once.
        val artifacts = bundle.artifacts.distinctBy { it.sha256 }.filter { it.sha256 != bundle.manifest.sha256 }
        val files = artifacts + bundle.manifest
        val alreadyStored = log?.stored(origin.toString()).orEmpty()
        val bytesTotal = files.sumOf { it.byteLength }
        var bytesDone = 0L
        var done = 0
        var sent = 0
        var skipped = 0
        onProgress(Progress(0, files.size, 0, bytesTotal))
        for (artifact in files) {
            // The manifest is always sent: it is the final confirmation that the whole bundle is stored.
            if (artifact !== bundle.manifest && artifact.sha256 in alreadyStored) {
                skipped++
            } else {
                val file = File(dir, artifact.path)
                verify(file, artifact)
                putWithRetry(origin, file, artifact)
                log?.record(origin.toString(), artifact.sha256)
                sent++
            }
            done++
            bytesDone += artifact.byteLength
            onProgress(Progress(done, files.size, bytesDone, bytesTotal))
        }
        return Result(bundle.manifest.uri, bundle.manifest.sha256, sent, skipped)
    }

    private fun verify(file: File, artifact: ArtifactFile) {
        if (!file.isFile || file.length() != artifact.byteLength || Hashing.sha256Hex(file) != artifact.sha256) {
            throw UploadFailedException("Scan file ${artifact.path} changed on the device; discard and rescan")
        }
    }

    private fun pace() {
        if (lastRequestAt != Long.MIN_VALUE) {
            val wait = lastRequestAt + minIntervalMs - now()
            if (wait > 0) sleep(wait)
        }
        lastRequestAt = now()
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
            pace()
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
        /** About 90 requests a minute, leaving the page headroom under the studio's 120. */
        const val DEFAULT_MIN_INTERVAL_MS = 667L

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
            429 -> "The studio at $origin is rate limiting uploads. Try again in a minute; finished files are kept."
            503 -> "The studio at $origin is not configured to accept uploads (HTTP 503)."
            else -> "Upload to $origin failed (HTTP $status)."
        }
    }
}
