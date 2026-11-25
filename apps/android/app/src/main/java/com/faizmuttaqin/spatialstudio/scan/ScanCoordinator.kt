package com.faizmuttaqin.spatialstudio.scan

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.concurrent.CopyOnWriteArraySet

/**
 * Process-wide state shared by every bridge instance and the scan screen: at
 * most one scan and one upload at a time, even after the WebView (and its
 * bridge) is rebuilt.
 */
object ScanCoordinator {
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

    @Synchronized
    fun endUpload(sessionId: String) {
        if (uploading == sessionId) uploading = null
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
