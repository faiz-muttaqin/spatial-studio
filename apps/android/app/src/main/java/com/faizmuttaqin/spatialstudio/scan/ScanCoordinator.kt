package com.faizmuttaqin.spatialstudio.scan

import com.faizmuttaqin.spatialstudio.bridge.BridgeErrorCode
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Process-wide state shared by every bridge instance and the scan screen: at
 * most one scan and one upload at a time, even after the WebView (and its
 * bridge) is rebuilt.
 */
object ScanCoordinator {
    /** How a `scan.upload` ended. */
    sealed class UploadOutcome {
        class Ok(val result: JsonObject) : UploadOutcome()
        class Failed(val code: BridgeErrorCode, val message: String) : UploadOutcome()
    }

    /** A page waiting for the reply to its `scan.upload`; answered once, when the upload ends. */
    fun interface UploadWaiter {
        fun onDone(outcome: UploadOutcome)
    }

    /** STARTED and REPLACED: the caller runs the upload. REPLACED took over a stalled upload of the same session. */
    enum class UploadJoin { STARTED, JOINED, REPLACED, BUSY }

    /** Handle of one upload run; [cancelled] is set when a newer run replaced it. */
    class UploadToken {
        val cancelled = AtomicBoolean(false)
    }

    class UploadAttempt(val join: UploadJoin, val token: UploadToken?)

    /** An upload with no progress or retry activity for this long is stalled and can be replaced. */
    const val UPLOAD_STALE_MS = 60_000L

    class ActiveScan(val sessionId: String, val projectId: String?, val options: ScanOptions)

    fun interface Listener {
        fun onScanEvent(event: String, data: JsonObject)
    }

    @Volatile
    var active: ActiveScan? = null
        private set

    /** True once the scan screen for [active] has opened. */
    private var started = false

    @Volatile
    var uploading: String? = null
        private set

    private val listeners = CopyOnWriteArraySet<Listener>()
    private val uploadWaiters = ArrayList<UploadWaiter>()
    private var uploadToken: UploadToken? = null
    private var uploadActivityMs = 0L

    private fun nowMs() = System.nanoTime() / 1_000_000

    @Synchronized
    fun begin(scan: ActiveScan): Boolean {
        if (active != null) return false
        active = scan
        started = false
        return true
    }

    /** Called by the scan screen when it opens for [sessionId]. */
    @Synchronized
    fun markStarted(sessionId: String): Boolean {
        if (active?.sessionId != sessionId) return false
        started = true
        return true
    }

    /**
     * Releases a scan whose screen never opened (for example a start blocked
     * while the app was in the background). Returns true when it released one.
     */
    @Synchronized
    fun expireIfNotStarted(sessionId: String): Boolean {
        if (active?.sessionId != sessionId || started) return false
        active = null
        return true
    }

    @Synchronized
    fun end(sessionId: String) {
        if (active?.sessionId == sessionId) {
            active = null
            started = false
        }
    }

    @Synchronized
    fun beginUpload(sessionId: String): Boolean {
        if (uploading != null) return false
        uploading = sessionId
        return true
    }

    /**
     * Starts the upload of [sessionId] ([UploadJoin.STARTED]: the caller runs it), or, when that same
     * session is already uploading, queues [waiter] to get the same result ([UploadJoin.JOINED]). A
     * different session is [UploadJoin.BUSY]. The waiter is queued in the first two cases.
     */
    @Synchronized
    fun beginOrJoinUpload(sessionId: String, waiter: UploadWaiter, nowMs: Long = nowMs()): UploadAttempt {
        val current = uploading
        if (current != null && current != sessionId) return UploadAttempt(UploadJoin.BUSY, null)
        uploadWaiters.add(waiter)
        if (current == null) {
            uploading = sessionId
            uploadToken = UploadToken().also { uploadActivityMs = nowMs }
            return UploadAttempt(UploadJoin.STARTED, uploadToken)
        }
        if (nowMs - uploadActivityMs >= UPLOAD_STALE_MS) {
            // The running upload showed no activity for a minute: cancel it and run a new one. Waiters are kept.
            uploadToken?.cancelled?.set(true)
            uploadToken = UploadToken()
            uploadActivityMs = nowMs
            return UploadAttempt(UploadJoin.REPLACED, uploadToken)
        }
        return UploadAttempt(UploadJoin.JOINED, null)
    }

    /** The upload of [token] made progress (or is retrying); keeps it from counting as stalled. */
    @Synchronized
    fun touchUpload(token: UploadToken, nowMs: Long = nowMs()) {
        if (uploadToken === token) uploadActivityMs = nowMs
    }

    /** Ends the upload and answers every waiter with [outcome]; a success is also emitted as `upload.done`. */
    fun finishUpload(sessionId: String, token: UploadToken, outcome: UploadOutcome) {
        val waiting = synchronized(this) {
            // A replaced run that finally returns must not answer for, or free, the run that replaced it.
            if (uploading != sessionId || uploadToken !== token) return
            uploading = null
            uploadToken = null
            uploadWaiters.toList().also { uploadWaiters.clear() }
        }
        waiting.forEach { runCatching { it.onDone(outcome) } }
        if (outcome is UploadOutcome.Ok) emit("upload.done", outcome.result)
    }

    @Synchronized
    fun endUpload(sessionId: String) {
        if (uploading == sessionId) {
            uploading = null
            uploadToken = null
            uploadWaiters.clear()
        }
    }

    fun addListener(listener: Listener) = listeners.add(listener)

    fun removeListener(listener: Listener) = listeners.remove(listener)

    fun state(sessionId: String, state: String, extra: JsonObjectBuilder.() -> Unit = {}) {
        emit(
            "scan.state",
            buildJsonObject {
                put("sessionId", sessionId)
                put("state", state)
                extra()
            },
        )
    }

    fun progress(data: JsonObject) = emit("scan.progress", data)

    fun emit(event: String, data: JsonObject) {
        listeners.forEach { it.onScanEvent(event, data) }
    }
}
