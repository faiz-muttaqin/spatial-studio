package com.faizmuttaqin.spatialstudio.scan

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.concurrent.CopyOnWriteArraySet

/**
 * Process-wide link between the bridge (in MainActivity) and the scan screen.
 * At most one scan runs at a time.
 */
object ScanCoordinator {
    class ActiveScan(val sessionId: String, val projectId: String?, val options: ScanOptions)

    fun interface Listener {
        fun onScanEvent(event: String, data: JsonObject)
    }

    @Volatile
    var active: ActiveScan? = null
        private set

    private val listeners = CopyOnWriteArraySet<Listener>()

    @Synchronized
    fun begin(scan: ActiveScan): Boolean {
        if (active != null) return false
        active = scan
        return true
    }

    @Synchronized
    fun end(sessionId: String) {
        if (active?.sessionId == sessionId) active = null
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
