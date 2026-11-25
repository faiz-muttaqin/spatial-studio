package com.faizmuttaqin.spatialstudio.upload

import com.faizmuttaqin.spatialstudio.scan.SessionRecord
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

object UploadResults {
    /**
     * The `scan.upload` result of a scan whose manifest is already stored (the record was written after
     * the manifest upload), so a repeated request needs no network work. Null when the scan is not uploaded.
     */
    fun alreadyUploaded(record: SessionRecord): JsonObject? {
        val sha = record.manifestSha256 ?: return null
        if (!record.uploaded) return null
        return buildJsonObject {
            put("sessionId", record.sessionId)
            put("manifestUrl", "/api/artifacts/$sha")
            put("manifestSha256", sha)
        }
    }
}
