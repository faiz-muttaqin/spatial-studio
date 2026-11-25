package com.faizmuttaqin.spatialstudio.upload

import com.faizmuttaqin.spatialstudio.scan.ArtifactFile
import com.faizmuttaqin.spatialstudio.scan.FinalizedBundle
import com.faizmuttaqin.spatialstudio.security.OriginAllowlist
import com.faizmuttaqin.spatialstudio.util.Hashing
import java.io.File
import java.io.IOException

/** Passed to a transport so one PUT reports activity and can be stopped. */
class PutControl(val onActivity: () -> Unit = {}, val isCancelled: () -> Boolean = { false })

/** Sends one artifact. Implementations must not follow redirects. */
fun interface ArtifactTransport {
    fun put(url: String, headers: Map<String, String>, file: File, length: Long): Response

    /**
     * As [put], but the transport calls [PutControl.onActivity] as bytes move and gives up (throwing
     * [IOException]) once [PutControl.isCancelled] turns true. The default ignores the control.
     */
    fun put(url: String, headers: Map<String, String>, file: File, length: Long, control: PutControl): Response =
        put(url, headers, file, length)

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
    /** Longest one artifact may take, retries and waits included. */
    private val maxArtifactMs: Long = MAX_ARTIFACT_MS,
    /** Longest the whole upload may take. */
    private val maxTotalMs: Long = MAX_TOTAL_MS,
    /** Retries across the whole upload. */
    private val maxTotalRetries: Int = MAX_TOTAL_RETRIES,
    /** Status codes and waits only: no URLs, cookies or bodies. */
    private val log: (String) -> Unit = {},
) {
    /** [phase]: `artifacts`, then `manifest` while the manifest is sent. */
    class Progress(
        val uploaded: Int,
        val total: Int,
        val bytesUploaded: Long,
        val bytesTotal: Long,
        val phase: String = PHASE_ARTIFACTS,
    )

    class Result(val manifestUrl: String, val manifestSha256: String, val sent: Int, val skipped: Int)

    fun upload(
        origin: OriginAllowlist.Origin,
        dir: File,
        bundle: FinalizedBundle,
        log: UploadLog? = null,
        isCancelled: () -> Boolean = { false },
        onActivity: () -> Unit = {},
        onProgress: (Progress) -> Unit = {},
    ): Result {
        val run = Run(isCancelled, onActivity)
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
            if (isCancelled()) throw UploadFailedException("Upload replaced by a newer request")
            if (now() - run.startedAt > maxTotalMs) throw UploadFailedException("Upload took too long; finished files are kept, try again")
            val phase = if (artifact === bundle.manifest) PHASE_MANIFEST else PHASE_ARTIFACTS
            if (artifact === bundle.manifest) onProgress(Progress(done, files.size, bytesDone, bytesTotal, phase))
            // The manifest is always sent: it is the final confirmation that the whole bundle is stored.
            if (artifact !== bundle.manifest && artifact.sha256 in alreadyStored) {
                skipped++
            } else {
                val file = File(dir, artifact.path)
                run.verify(file, artifact)
                run.putWithRetry(origin, file, artifact) {
                    onProgress(Progress(done, files.size, bytesDone, bytesTotal, phase))
                }
                log?.record(origin.toString(), artifact.sha256)
                sent++
            }
            done++
            bytesDone += artifact.byteLength
            onProgress(Progress(done, files.size, bytesDone, bytesTotal, phase))
        }
        return Result(bundle.manifest.uri, bundle.manifest.sha256, sent, skipped)
    }

    /** One call of [upload]: its own clock, retry count and pacing, so a replaced run cannot disturb the next. */
    private inner class Run(
        val isCancelled: () -> Boolean,
        val onActivity: () -> Unit,
    ) {
        val startedAt = now()
        var totalRetries = 0
        var lastRequestAt = Long.MIN_VALUE

        fun verify(file: File, artifact: ArtifactFile) {
            if (!file.isFile || file.length() != artifact.byteLength || Hashing.sha256Hex(file) != artifact.sha256) {
                throw UploadFailedException("Scan file ${artifact.path} changed on the device; discard and rescan")
            }
        }

        fun pace() {
            if (lastRequestAt != Long.MIN_VALUE) {
                val wait = lastRequestAt + minIntervalMs - now()
                if (wait > 0) sleep(wait)
            }
            lastRequestAt = now()
        }

        fun putWithRetry(origin: OriginAllowlist.Origin, file: File, artifact: ArtifactFile, onRetry: () -> Unit) {
            val artifactStart = now()
            val url = "$origin/api/artifacts/${artifact.sha256}"
            val headers = LinkedHashMap<String, String>()
            headers["Origin"] = origin.toString()
            headers["Content-Type"] = artifact.mediaType
            cookies.cookieFor(origin.toString())?.takeIf { it.isNotBlank() }?.let { headers["Cookie"] = it }
            val control = PutControl(onActivity, isCancelled)

            var attempt = 0
            while (true) {
                if (isCancelled()) throw UploadFailedException("Upload replaced by a newer request")
                attempt++
                pace()
                onActivity()
                val response = try {
                    transport.put(url, headers, file, artifact.byteLength, control)
                } catch (e: IOException) {
                    null
                }
                if (isCancelled()) throw UploadFailedException("Upload replaced by a newer request")
                val status = response?.status ?: -1
                if (status in 200..299) return
                val retryable = status == -1 || status == 408 || status == 429 || status in 500..599
                if (!retryable) throw UploadFailedException(describe(status, origin))
                if (attempt >= maxAttempts) {
                    throw UploadFailedException(
                        if (status == -1) "Network error uploading to $origin" else describe(status, origin),
                    )
                }
                val delay = retryDelayMs(status, response?.retryAfterSeconds, attempt)
                totalRetries++
                log("retry ${artifact.path} attempt=$attempt status=$status wait=${delay}ms")
                if (totalRetries > maxTotalRetries || now() - artifactStart + delay > maxArtifactMs || now() - startedAt + delay > maxTotalMs) {
                    throw UploadFailedException(
                        if (status == -1) "Network error uploading to $origin; finished files are kept, try again" else describe(status, origin),
                    )
                }
                onRetry()
                sleep(delay)
            }
        }
    }

    companion object {
        /** About 90 requests a minute, leaving the page headroom under the studio's 120. */
        const val DEFAULT_MIN_INTERVAL_MS = 667L
        const val PHASE_ARTIFACTS = "artifacts"
        const val PHASE_MANIFEST = "manifest"
        const val PHASE_FINALISING = "finalising"
        const val MAX_ARTIFACT_MS = 120_000L
        const val MAX_TOTAL_MS = 30L * 60 * 1000
        const val MAX_TOTAL_RETRIES = 100

        fun retryDelayMs(status: Int, retryAfterSeconds: Long?, attempt: Int): Long {
            if (status == 429 && retryAfterSeconds != null) return retryAfterSeconds.coerceIn(1, 30) * 1000
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
