package com.faizmuttaqin.spatialstudio.scan

import com.faizmuttaqin.spatialstudio.util.JsonUtil
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import java.io.File

/** Local bookkeeping for one scan; never uploaded. */
data class SessionRecord(
    val sessionId: String,
    val createdAtMs: Long,
    val projectId: String?,
    /** `recording`, `ready` or `failed`. */
    val state: String,
    val keyframes: Int = 0,
    val bytes: Long = 0,
    val manifestSha256: String? = null,
    val uploadedAtMs: Long? = null,
    /** Why a `failed` scan could not be saved; the files stay until discarded. */
    val error: String? = null,
) {
    val uploaded: Boolean get() = uploadedAtMs != null

    companion object {
        const val RECORDING = "recording"
        const val READY = "ready"
        const val FAILED = "failed"
    }
}

/**
 * Scan bundles in app-private storage, one directory per session id. Only
 * UUID-shaped ids map to a directory, so a request cannot reach other paths.
 */
class ScanStore(val root: File) {

    fun dir(sessionId: String): File {
        require(ScanParams.isSessionId(sessionId)) { "Invalid session id" }
        return File(root, sessionId)
    }

    fun create(sessionId: String, projectId: String?, createdAtMs: Long): File {
        val dir = dir(sessionId)
        check(!dir.exists()) { "Session already exists" }
        check(dir.mkdirs()) { "Could not create session directory" }
        write(SessionRecord(sessionId, createdAtMs, projectId, SessionRecord.RECORDING))
        return dir
    }

    fun read(sessionId: String): SessionRecord? {
        if (!ScanParams.isSessionId(sessionId)) return null
        val file = File(dir(sessionId), RECORD_FILE)
        if (!file.isFile) return null
        return runCatching { decode(JsonUtil.json.parseToJsonElement(file.readText()) as JsonObject) }.getOrNull()
    }

    fun write(record: SessionRecord) {
        val json = buildJsonObject {
            put("sessionId", record.sessionId)
            put("createdAtMs", record.createdAtMs)
            put("projectId", record.projectId)
            put("state", record.state)
            put("keyframes", record.keyframes)
            put("bytes", record.bytes)
            put("manifestSha256", record.manifestSha256)
            put("uploadedAtMs", record.uploadedAtMs)
            put("error", record.error)
        }
        JsonUtil.writeAtomically(File(dir(record.sessionId), RECORD_FILE), JsonUtil.encode(json).toByteArray(Charsets.UTF_8))
    }

    /** Newest first, at most [limit] entries so a `scan.list` reply stays small. */
    fun list(limit: Int = 50): List<SessionRecord> {
        val dirs = root.listFiles { f -> f.isDirectory && ScanParams.isSessionId(f.name) } ?: return emptyList()
        return dirs.mapNotNull { read(it.name) }.sortedByDescending { it.createdAtMs }.take(limit)
    }

    fun discard(sessionId: String): Boolean {
        val dir = dir(sessionId)
        if (!dir.exists()) return false
        return dir.deleteRecursively()
    }

    /**
     * Deletes scans abandoned mid-recording (the process died) and directories
     * without a record, once they are older than [maxAgeMs]. Ready and failed
     * scans stay until the user uploads or discards them.
     */
    fun sweepStale(nowMs: Long, maxAgeMs: Long, activeSessionId: String?): Int {
        val dirs = root.listFiles { f -> f.isDirectory && ScanParams.isSessionId(f.name) } ?: return 0
        var removed = 0
        for (dir in dirs) {
            if (dir.name == activeSessionId) continue
            val record = read(dir.name)
            val stale = when {
                record == null -> nowMs - dir.lastModified() > maxAgeMs
                record.state == SessionRecord.RECORDING -> nowMs - record.createdAtMs > maxAgeMs
                else -> false
            }
            if (stale && dir.deleteRecursively()) removed++
        }
        return removed
    }

    fun uploadPlan(sessionId: String): FinalizedBundle = UploadPlanFile.read(File(dir(sessionId), ScanBundle.UPLOAD_PLAN_FILE))

    fun usableBytes(): Long {
        root.mkdirs()
        return root.usableSpace
    }

    private fun decode(obj: JsonObject): SessionRecord {
        fun str(key: String) = (obj[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
        fun long(key: String) = (obj[key] as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull
        return SessionRecord(
            sessionId = requireNotNull(str("sessionId")),
            createdAtMs = long("createdAtMs") ?: 0,
            projectId = str("projectId"),
            state = str("state") ?: SessionRecord.FAILED,
            keyframes = (long("keyframes") ?: 0).toInt(),
            bytes = long("bytes") ?: 0,
            manifestSha256 = str("manifestSha256"),
            uploadedAtMs = long("uploadedAtMs"),
            error = str("error"),
        )
    }

    private companion object {
        const val RECORD_FILE = "session.json"
    }
}
