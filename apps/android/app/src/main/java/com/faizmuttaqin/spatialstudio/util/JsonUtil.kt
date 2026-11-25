package com.faizmuttaqin.spatialstudio.util

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import kotlin.math.pow
import kotlin.math.roundToLong

object JsonUtil {
    val json = Json { prettyPrint = false; ignoreUnknownKeys = true }

    /** Rounds to [decimals] places; non-finite values must be filtered by the caller. */
    fun rounded(value: Double, decimals: Int): JsonPrimitive {
        require(value.isFinite()) { "Non-finite number cannot be written as JSON" }
        val factor = 10.0.pow(decimals)
        return JsonPrimitive((value * factor).roundToLong() / factor)
    }

    fun matrix(values: FloatArray): JsonArray {
        require(values.size == 16) { "Expected a 4x4 matrix" }
        return JsonArray(values.map { rounded(it.toDouble(), 6) })
    }

    fun isoUtc(epochMs: Long): String =
        SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
            .apply { timeZone = TimeZone.getTimeZone("UTC") }
            .format(Date(epochMs))

    fun encode(element: JsonElement): String = json.encodeToString(JsonElement.serializer(), element)

    /** Writes through a temporary file and renames, so readers never see half a file. */
    fun writeAtomically(file: File, bytes: ByteArray) {
        val tmp = File(file.parentFile, ".${file.name}.tmp")
        tmp.writeBytes(bytes)
        if (!tmp.renameTo(file)) {
            file.delete()
            check(tmp.renameTo(file)) { "Could not write ${file.name}" }
        }
    }
}
