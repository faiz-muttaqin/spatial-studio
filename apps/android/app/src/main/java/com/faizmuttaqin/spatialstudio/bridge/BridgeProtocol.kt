package com.faizmuttaqin.spatialstudio.bridge

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put

/** Error codes from CAPTURE_CONTRACT.md, bridge protocol v1. */
enum class BridgeErrorCode(val wire: String) {
    FORBIDDEN("forbidden"),
    INVALID_REQUEST("invalid_request"),
    UNKNOWN_METHOD("unknown_method"),
    UNSUPPORTED("unsupported"),
    PERMISSION_DENIED("permission_denied"),
    BUSY("busy"),
    NOT_FOUND("not_found"),
    UPLOAD_FAILED("upload_failed"),
    INTERNAL("internal"),
}

class BridgeException(val code: BridgeErrorCode, message: String) : Exception(message)

data class BridgeRequest(val id: String, val method: String, val params: JsonObject)

/** Wire format of bridge protocol v1: parsing, validation and envelopes. No Android types. */
object BridgeProtocol {
    const val VERSION = 1
    const val MAX_MESSAGE_BYTES = 64 * 1024
    const val MAX_ID_LENGTH = 128

    val METHODS = listOf(
        "bridge.hello",
        "capabilities.get",
        "scan.start",
        "scan.list",
        "scan.upload",
        "scan.discard",
    )

    val EVENTS = setOf("scan.state", "scan.progress", "upload.progress")

    private val ID_PATTERN = Regex("^[A-Za-z0-9._:-]{1,$MAX_ID_LENGTH}$")

    private val json = Json { prettyPrint = false }

    /** Outcome of [parse]: a request, or an error with whatever id could be recovered. */
    sealed interface Parsed {
        data class Ok(val request: BridgeRequest) : Parsed
        data class Error(val id: String, val code: BridgeErrorCode, val message: String) : Parsed
    }

    fun parse(raw: String?): Parsed {
        if (raw == null) return Parsed.Error("", BridgeErrorCode.INVALID_REQUEST, "Message must be a JSON string")
        // UTF-8 is at least one byte per char, so a long string is rejected before encoding it.
        if (raw.length > MAX_MESSAGE_BYTES || raw.toByteArray(Charsets.UTF_8).size > MAX_MESSAGE_BYTES) {
            return Parsed.Error("", BridgeErrorCode.INVALID_REQUEST, "Message exceeds $MAX_MESSAGE_BYTES bytes")
        }
        val element = runCatching { json.parseToJsonElement(raw) }.getOrNull()
            ?: return Parsed.Error("", BridgeErrorCode.INVALID_REQUEST, "Message is not valid JSON")
        val obj = element as? JsonObject
            ?: return Parsed.Error("", BridgeErrorCode.INVALID_REQUEST, "Message must be a JSON object")

        val idPrimitive = obj["id"] as? JsonPrimitive
        val id = idPrimitive?.takeIf { it.isString }?.content
        val replyId = id?.takeIf { ID_PATTERN.matches(it) } ?: ""

        val version = (obj["v"] as? JsonPrimitive)?.takeIf { !it.isString }?.intOrNull
        if (version != VERSION) {
            return Parsed.Error(replyId, BridgeErrorCode.INVALID_REQUEST, "Unsupported protocol version; expected v=$VERSION")
        }
        if (id == null || !ID_PATTERN.matches(id)) {
            return Parsed.Error(replyId, BridgeErrorCode.INVALID_REQUEST, "id must match ${ID_PATTERN.pattern}")
        }
        val method = (obj["method"] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
            ?: return Parsed.Error(id, BridgeErrorCode.INVALID_REQUEST, "method must be a string")
        val params = when (val p = obj["params"]) {
            null, JsonNull -> JsonObject(emptyMap())
            is JsonObject -> p
            else -> return Parsed.Error(id, BridgeErrorCode.INVALID_REQUEST, "params must be an object")
        }
        if (method !in METHODS) {
            return Parsed.Error(id, BridgeErrorCode.UNKNOWN_METHOD, "Unknown method: ${method.take(64)}")
        }
        return Parsed.Ok(BridgeRequest(id, method, params))
    }

    fun okReply(id: String, result: JsonElement): String = json.encodeToString(
        JsonObject.serializer(),
        buildJsonObject {
            put("v", VERSION)
            put("id", id)
            put("ok", true)
            put("result", result)
        },
    )

    fun errorReply(id: String, code: BridgeErrorCode, message: String): String = json.encodeToString(
        JsonObject.serializer(),
        buildJsonObject {
            put("v", VERSION)
            put("id", id)
            put("ok", false)
            put(
                "error",
                buildJsonObject {
                    put("code", code.wire)
                    put("message", message.take(500))
                },
            )
        },
    )

    fun event(name: String, data: JsonElement): String {
        require(name in EVENTS) { "Unknown event: $name" }
        return json.encodeToString(
            JsonObject.serializer(),
            buildJsonObject {
                put("v", VERSION)
                put("event", name)
                put("data", data)
            },
        )
    }

    /** True when an outgoing message fits the same 64 KiB limit as incoming ones. */
    fun fits(message: String): Boolean = message.toByteArray(Charsets.UTF_8).size <= MAX_MESSAGE_BYTES
}
