package com.faizmuttaqin.spatialstudio.scan

import com.faizmuttaqin.spatialstudio.bridge.BridgeErrorCode
import com.faizmuttaqin.spatialstudio.bridge.BridgeException
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull

data class ScanOptions(
    val depth: Boolean = true,
    val keyframeSpacingM: Double = DEFAULT_SPACING_M,
    val keyframeAngleDeg: Double = DEFAULT_ANGLE_DEG,
    val maxKeyframes: Int = MAX_KEYFRAMES,
    /** Orientation, heading, light estimate and barometer. */
    val sensors: Boolean = true,
    /** Approximate location for `geolocation` and the compass declination. Off unless the page opts in. */
    val location: Boolean = false,
) {
    companion object {
        const val DEFAULT_SPACING_M = 0.25
        const val DEFAULT_ANGLE_DEG = 15.0
        const val MAX_KEYFRAMES = 300
        const val MIN_SPACING_M = 0.05
        const val MAX_SPACING_M = 2.0
        const val MAX_PROJECT_ID_LENGTH = 200
    }
}

data class ScanStartParams(val projectId: String?, val options: ScanOptions)

/** Validation of `scan.*` params. Throws [BridgeException] with `invalid_request`. */
object ScanParams {
    private val SESSION_ID = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

    fun isSessionId(value: String?): Boolean = value != null && SESSION_ID.matches(value)

    fun sessionId(params: JsonObject): String {
        val value = (params["sessionId"] as? JsonPrimitive)?.takeIf { it.isString }?.content
        if (!isSessionId(value)) invalid("sessionId must be a lowercase UUID")
        return value!!
    }

    fun start(params: JsonObject): ScanStartParams {
        val projectId = when (val p = params["projectId"]) {
            null, JsonNull -> null
            is JsonPrimitive -> {
                if (!p.isString) invalid("projectId must be a string")
                val value = p.content
                if (value.isEmpty() || value.length > ScanOptions.MAX_PROJECT_ID_LENGTH || value.any { it.isISOControl() }) {
                    invalid("projectId must be 1-${ScanOptions.MAX_PROJECT_ID_LENGTH} printable characters")
                }
                value
            }
            else -> invalid("projectId must be a string")
        }
        val options = when (val o = params["options"]) {
            null, JsonNull -> ScanOptions()
            is JsonObject -> options(o)
            else -> invalid("options must be an object")
        }
        return ScanStartParams(projectId, options)
    }

    private fun options(o: JsonObject): ScanOptions {
        val defaults = ScanOptions()
        val depth = o["depth"]?.let { (it as? JsonPrimitive)?.takeIf { p -> !p.isString }?.booleanOrNull ?: invalid("options.depth must be a boolean") }
        val spacing = o["keyframeSpacingM"]?.let {
            val v = (it as? JsonPrimitive)?.takeIf { p -> !p.isString }?.doubleOrNull ?: invalid("options.keyframeSpacingM must be a number")
            if (v.isNaN() || v < ScanOptions.MIN_SPACING_M || v > ScanOptions.MAX_SPACING_M) {
                invalid("options.keyframeSpacingM must be between ${ScanOptions.MIN_SPACING_M} and ${ScanOptions.MAX_SPACING_M}")
            }
            v
        }
        val max = o["maxKeyframes"]?.let {
            val v = (it as? JsonPrimitive)?.takeIf { p -> !p.isString }?.intOrNull ?: invalid("options.maxKeyframes must be an integer")
            if (v < 1 || v > ScanOptions.MAX_KEYFRAMES) invalid("options.maxKeyframes must be between 1 and ${ScanOptions.MAX_KEYFRAMES}")
            v
        }
        val sensors = o["sensors"]?.let { (it as? JsonPrimitive)?.takeIf { p -> !p.isString }?.booleanOrNull ?: invalid("options.sensors must be a boolean") }
        val location = o["location"]?.let { (it as? JsonPrimitive)?.takeIf { p -> !p.isString }?.booleanOrNull ?: invalid("options.location must be a boolean") }
        return ScanOptions(
            sensors = sensors ?: defaults.sensors,
            location = location ?: defaults.location,
            depth = depth ?: defaults.depth,
            keyframeSpacingM = spacing ?: defaults.keyframeSpacingM,
            maxKeyframes = max ?: defaults.maxKeyframes,
        )
    }

    private fun invalid(message: String): Nothing = throw BridgeException(BridgeErrorCode.INVALID_REQUEST, message)
}
