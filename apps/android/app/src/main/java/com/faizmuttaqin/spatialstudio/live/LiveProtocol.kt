package com.faizmuttaqin.spatialstudio.live

import com.faizmuttaqin.spatialstudio.bridge.BridgeErrorCode
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put

/**
 * The two-method listener the live preview page gets (`SpatialStudioLive`), kept apart from the scan
 * bridge: it can open or close the preview stream and nothing else. Same envelope as bridge v1.
 */
object LiveProtocol {
    const val OBJECT_NAME = "SpatialStudioLive"
    const val MAX_MESSAGE_BYTES = 1024
    val METHODS = setOf("live.open", "live.close")
    val TRANSPORTS = setOf("port", "ws")
    private val ID_PATTERN = Regex("^[A-Za-z0-9._:-]{1,128}$")
    private val json = Json { prettyPrint = false }

    sealed interface Parsed {
        class Open(val id: String, val transport: String) : Parsed
        class Close(val id: String) : Parsed
        class Error(val id: String, val code: BridgeErrorCode, val message: String) : Parsed
    }

    fun parse(raw: String?): Parsed {
        if (raw == null || raw.length > MAX_MESSAGE_BYTES) return Parsed.Error("", BridgeErrorCode.INVALID_REQUEST, "Message must be a short JSON string")
        val obj = runCatching { json.parseToJsonElement(raw) }.getOrNull() as? JsonObject
            ?: return Parsed.Error("", BridgeErrorCode.INVALID_REQUEST, "Message must be a JSON object")
        val id = (obj["id"] as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { ID_PATTERN.matches(it) }
            ?: return Parsed.Error("", BridgeErrorCode.INVALID_REQUEST, "id must match ${ID_PATTERN.pattern}")
        val version = (obj["v"] as? JsonPrimitive)?.takeIf { !it.isString }?.intOrNull
        if (version != 1) return Parsed.Error(id, BridgeErrorCode.INVALID_REQUEST, "Unsupported protocol version")
        return when ((obj["method"] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull) {
            "live.close" -> Parsed.Close(id)
            "live.open" -> {
                val transport = ((obj["params"] as? JsonObject)?.get("transport") as? JsonPrimitive)?.takeIf { it.isString }?.content
                if (transport !in TRANSPORTS) Parsed.Error(id, BridgeErrorCode.INVALID_REQUEST, "transport must be port or ws") else Parsed.Open(id, transport!!)
            }
            else -> Parsed.Error(id, BridgeErrorCode.UNKNOWN_METHOD, "Unknown method")
        }
    }

    fun ok(id: String, build: kotlinx.serialization.json.JsonObjectBuilder.() -> Unit = {}): String = json.encodeToString(
        JsonObject.serializer(),
        buildJsonObject {
            put("v", 1)
            put("id", id)
            put("ok", true)
            put("result", buildJsonObject(build))
        },
    )

    fun error(id: String, code: BridgeErrorCode, message: String): String = json.encodeToString(
        JsonObject.serializer(),
        buildJsonObject {
            put("v", 1)
            put("id", id)
            put("ok", false)
            put("error", buildJsonObject { put("code", code.wire); put("message", message.take(200)) })
        },
    )

    /** Pushed by the app: `ready` when a page may open the stream, `closed` after the app closed it. */
    fun event(state: String): String = json.encodeToString(
        JsonObject.serializer(),
        buildJsonObject {
            put("v", 1)
            put("event", "live.state")
            put("data", buildJsonObject { put("state", state) })
        },
    )
}
